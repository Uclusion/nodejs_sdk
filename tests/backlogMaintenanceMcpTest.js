import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, mcpText, pollFor, sleep } from './commonTestFunctions.js';

// J-all-500: find_work carries a daily backlog maintenance notice, one agent claims the run,
// and recording it clears the notice. Only a run that found something reaches the inbox.
export default function (adminConfiguration) {
  describe('#test backlog maintenance run (J-all-500)', () => {
    let accountClient;
    let accountToken;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      ({ client: accountClient, accountToken } = await loginUserToAccountAndGetToken(adminConfiguration));
    });

    // Each run needs its own workspace, because a workspace with no recorded run gets its
    // notice at once while a recorded one waits a day.
    async function createWorkspace(name) {
      const result = await accountClient.markets.createMarket({ name, market_type: 'PLANNING' });
      const marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const { client } = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      const uclusionToken = await mcpLogin(adminConfiguration, client, marketId);
      const ready = await pollFor(async () => {
        const versions = await accountClient.summaries.versions(accountToken, [marketId]);
        return versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures
          ?.find((entry) => entry.type === 'market_capability')?.object_versions || [];
      }, (capabilities) => capabilities.length >= 2);
      assert(ready.length >= 2, 'The human and planning AI must be ready before one-shot writes');
      return { marketId, uclusionToken };
    }

    function toolResult(raw) {
      return JSON.parse(raw).result;
    }

    // Retries only transport failures for reads and idempotent writes. Creations and claims go
    // through mcpCall once, since a repeated claim is refused by the claim it repeats.
    async function pollMcp(workspace, toolName, args) {
      for (let i = 0; i < 10; i += 1) {
        try {
          return await mcpCall(adminConfiguration, workspace.uclusionToken, toolName, args);
        } catch (error) {
          await sleep(3000);
        }
      }
      return mcpCall(adminConfiguration, workspace.uclusionToken, toolName, args);
    }

    async function addBug(workspace, body) {
      const added = toolResult(await mcpCall(adminConfiguration, workspace.uclusionToken, 'add_bug',
        { bug: body, severity: 'YELLOW' }));
      assert.notStrictEqual(added.isError, true, JSON.stringify(added));
      return added.structuredContent;
    }

    async function findWork(workspace) {
      return JSON.parse(mcpText(await pollMcp(workspace, 'find_work', {})));
    }

    async function noticeListing(workspace, code) {
      const work = await pollFor(() => findWork(workspace),
        (found) => (found.backlog_maintenance?.completed || []).some((item) => item.code === code));
      const notice = work?.backlog_maintenance;
      assert(notice, `find_work never carried a backlog_maintenance notice listing ${code}: ${JSON.stringify(work)}`);
      return notice;
    }

    async function runTool(workspace, args) {
      return toolResult(await mcpCall(adminConfiguration, workspace.uclusionToken, 'backlog_maintenance_run',
        args));
    }

    async function claim(workspace, notice) {
      const claimed = await runTool(workspace, { action: 'claim', since: notice.since, through: notice.through });
      assert.notStrictEqual(claimed.isError, true, `The first claim must succeed: ${JSON.stringify(claimed)}`);
      assert(claimed.structuredContent?.claim_id, `A claim returns its id: ${JSON.stringify(claimed)}`);
      assert(claimed.structuredContent?.expires_at, `A claim returns its expiry: ${JSON.stringify(claimed)}`);
      return claimed.structuredContent.claim_id;
    }

    async function reportRows(marketId) {
      return ((await getMessages(adminConfiguration)) || [])
        .filter((message) => message.market_id === marketId && message.type === 'BACKLOG_MAINTENANCE');
    }

    it('claims a run once, delivers its report as one inbox item and clears the notice', async function () {
      this.timeout(900000);
      const workspace = await createWorkspace('Backlog maintenance with findings');
      const marker = randomUUID();
      const resolvedBug = await addBug(workspace, `Fixed bug ${marker}`);
      const openBug = await addBug(workspace, `Open bug ${marker}`);
      await pollMcp(workspace, 'resolve', { short_code_id: resolvedBug.short_code_id });

      const notice = await noticeListing(workspace, resolvedBug.short_code_id);
      const listed = notice.completed.find((item) => item.code === resolvedBug.short_code_id);
      assert.strictEqual(listed.kind, 'bug', `The resolved bug is listed as a bug: ${JSON.stringify(notice)}`);
      assert(listed.name.includes(marker), `The resolved bug is listed by its name: ${JSON.stringify(notice)}`);
      assert(!notice.completed.some((item) => item.code === openBug.short_code_id),
        `An open bug is not completed: ${JSON.stringify(notice)}`);

      const claimId = await claim(workspace, notice);
      const second = await runTool(workspace, { action: 'claim', since: notice.since, through: notice.through });
      assert.strictEqual(second.isError, true, `A second claim must be refused: ${JSON.stringify(second)}`);
      assert(second.content?.[0]?.text?.includes('unexpired claim'),
        `The refusal names the unexpired claim: ${JSON.stringify(second)}`);
      const whileClaimed = await findWork(workspace);
      assert(!('backlog_maintenance' in whileClaimed),
        `find_work leaves out the notice while a claim is unexpired: ${JSON.stringify(whileClaimed)}`);

      const report = `1. ${openBug.short_code_id} may be obsolete now that ${resolvedBug.short_code_id} is fixed.`;
      const recorded = await runTool(workspace, { action: 'record', claim_id: claimId, report });
      assert.notStrictEqual(recorded.isError, true, `Recording must succeed: ${JSON.stringify(recorded)}`);
      assert.deepStrictEqual(recorded.structuredContent, { last_run: notice.through, report_delivered: true });

      const rows = await pollFor(() => reportRows(workspace.marketId), (found) => found.length > 0);
      assert.strictEqual(rows.length, 1, `One report row for the human: ${JSON.stringify(rows)}`);
      const [row] = rows;
      assert.strictEqual(row.type_object_id, `BACKLOG_MAINTENANCE_${claimId}`);
      assert.strictEqual(row.level, 'YELLOW');
      assert.strictEqual(row.alert_type, 'AI_GENERATED');
      assert.strictEqual(row.inbox_only, true);
      const openBugLink = new RegExp(
        `<a href="[^"]*#c${openBug.comment_id}"[^>]*>${openBug.short_code_id}</a>`);
      assert.match(row.text || '', openBugLink, 'The report text links the open bug it names');

      const after = await findWork(workspace);
      assert(!('backlog_maintenance' in after), `Recording clears the notice: ${JSON.stringify(after)}`);
    });

    it('records a run with no findings without an inbox item', async function () {
      this.timeout(900000);
      const workspace = await createWorkspace('Backlog maintenance without findings');
      const resolvedBug = await addBug(workspace, `Fixed bug ${randomUUID()}`);
      await pollMcp(workspace, 'resolve', { short_code_id: resolvedBug.short_code_id });

      const notice = await noticeListing(workspace, resolvedBug.short_code_id);
      const claimId = await claim(workspace, notice);
      const recorded = await runTool(workspace, { action: 'record', claim_id: claimId });
      assert.notStrictEqual(recorded.isError, true, `Recording must succeed: ${JSON.stringify(recorded)}`);
      assert.deepStrictEqual(recorded.structuredContent, { last_run: notice.through, report_delivered: false });

      // Delivery finishes before record returns, so this wait only covers the inbox index catching up.
      await sleep(10000);
      assert.deepStrictEqual(await reportRows(workspace.marketId), [],
        'A run without findings delivers no inbox item');
      const after = await findWork(workspace);
      assert(!('backlog_maintenance' in after), `Recording clears the notice: ${JSON.stringify(after)}`);
    });
  });
}
