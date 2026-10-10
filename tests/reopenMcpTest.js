import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, mcpText, pollFor, sleep } from './commonTestFunctions.js';

// J-all-485: an agent reopens a resolved comment itself when a fix turns out not to work.
export default function (adminConfiguration) {
  describe('#test reopen through MCP (J-all-485)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
    let uclusionToken;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      accountToken = accountLogin.accountToken;
      const result = await accountClient.markets.createMarket({
        name: 'Reopen MCP integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      ({ client: adminClient } = await loginUserToMarketAndGetToken(adminConfiguration, marketId));
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
      const ready = await pollFor(async () => {
        const versions = await accountClient.summaries.versions(accountToken, [marketId]);
        return versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures
          ?.find((entry) => entry.type === 'market_capability')?.object_versions || [];
      }, (capabilities) => capabilities.length >= 2);
      assert(ready.length >= 2, 'The human and planning AI must be ready before one-shot writes');
    });

    // The AI user is created async on market creation, so retry a read or an idempotent write
    // until it works. Creations go through mcpCall once, since each call creates another item.
    async function pollMcp(toolName, args) {
      for (let i = 0; i < 10; i += 1) {
        try {
          return await mcpCall(adminConfiguration, uclusionToken, toolName, args);
        } catch (error) {
          await sleep(3000);
        }
      }
      return mcpCall(adminConfiguration, uclusionToken, toolName, args);
    }

    function extractShortCode(responseText) {
      const result = JSON.parse(responseText).result;
      assert.notStrictEqual(result.isError, true, responseText);
      const code = result.structuredContent?.short_code_id ||
        result.content?.[0]?.text.match(/\bJ-[^\s/<>"]+-\d+\b/)?.[0];
      assert(code, `No short code in response: ${responseText}`);
      return code;
    }

    function toolResult(raw) {
      return JSON.parse(raw).result;
    }

    async function jobStage(jobCode) {
      return toolResult(await pollMcp('get_job', { short_code_id: jobCode, stage_only: true })).structuredContent.stage;
    }

    const OPTIONS = [
      { name: 'Retry the fix', description: 'Try the fix again.' },
      { name: 'Leave it', description: 'Accept the failure.' }
    ];
    const VOTE = { new_option_index: 0, certainty: 3, reason: 'The fix is still needed.' };

    it('reopens a resolved bug so it can become a question job again', async () => {
      const marker = randomUUID();
      const addedBug = toolResult(await mcpCall(adminConfiguration, uclusionToken, 'add_bug',
        { bug: `Back still fails ${marker}`, severity: 'RED' }));
      const bugCode = addedBug.structuredContent.short_code_id;
      await pollMcp('resolve', { short_code_id: bugCode });
      const resolved = await pollFor(
        async () => (await adminClient.investibles.getMarketComments([
          { id: addedBug.structuredContent.comment_id, version: 1 }
        ]))[0],
        (bug) => bug?.resolved === true);
      assert.strictEqual(resolved?.resolved, true);
      assert.strictEqual(resolved.ticket_code, bugCode);
      assert.strictEqual(resolved.comment_type, 'TODO');
      assert(mcpText(await pollMcp('get_job', { short_code_id: bugCode })).includes(bugCode));

      const refused = toolResult(await mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
        job_id: bugCode, question: `Retry ${marker}?`, options: OPTIONS, initial_vote: VOTE
      }));
      assert.strictEqual(refused?.isError, true, `Converting a resolved bug must be refused: ${JSON.stringify(refused)}`);

      // The human reported the failure, so the reopen is theirs.
      const reopened = toolResult(await pollMcp('reopen',
        { short_code_id: bugCode, for_human: true, is_my_lane: true }));
      assert.notStrictEqual(reopened?.isError, true, JSON.stringify(reopened));
      assert.deepStrictEqual(reopened?.structuredContent, { short_code_id: bugCode, status: 'reopened' },
        JSON.stringify(reopened));
      const open = await pollFor(
        async () => (await adminClient.investibles.getMarketComments([
          { id: addedBug.structuredContent.comment_id, version: resolved.version }
        ]))[0],
        (bug) => bug && bug.resolved !== true);
      assert(open && open.resolved !== true);
      assert.strictEqual(open.ticket_code, bugCode);
      assert.strictEqual(open.comment_type, 'TODO');
      assert(mcpText(await pollMcp('get_job', { short_code_id: bugCode })).includes(bugCode));

      const converted = await mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
        job_id: bugCode, question: `Retry ${marker}?`, options: OPTIONS, initial_vote: VOTE
      });
      assert.notStrictEqual(toolResult(converted)?.isError, true, converted);
      assert(mcpText(converted).includes(bugCode),
        `The conversion should return the reopened bug code: ${converted}`);
    }).timeout(300000);

    it('returns a Reviewable job to Doable when its assignee reopens a task', async () => {
      const marker = randomUUID();
      const jobCode = extractShortCode(await mcpCall(adminConfiguration, uclusionToken, 'add_job', {
        name: `Reopen task job ${marker}`, description: 'A job whose finished task turns out to fail.'
      }));
      const taskCode = extractShortCode(await mcpCall(adminConfiguration, uclusionToken, 'add_task',
        { job_id: jobCode, task: `Fix that fails later ${marker}` }));
      await pollMcp('resolve', { short_code_id: taskCode });
      const from = await jobStage(jobCode);
      if (from !== 'Doable') {
        await pollMcp('change_job_stage', { job_id: jobCode, from_stage: from, stage: 'Doable' });
      }
      await pollMcp('change_job_stage', { job_id: jobCode, from_stage: 'Doable', stage: 'Reviewable' });
      assert.strictEqual(await pollFor(() => jobStage(jobCode), (stage) => stage === 'Reviewable'), 'Reviewable');

      // The connected human is the job's assignee, so their reopen follows the assignee rule.
      const reopened = toolResult(await pollMcp('reopen',
        { short_code_id: taskCode, for_human: true, is_my_lane: true }));
      assert.notStrictEqual(reopened?.isError, true, JSON.stringify(reopened));
      const stage = await pollFor(() => jobStage(jobCode), (current) => current === 'Doable');
      assert.strictEqual(stage, 'Doable', 'The assignee reopening a task should return the job to Doable');
    }).timeout(300000);

    it('refuses to reopen a comment that is already open', async () => {
      const marker = randomUUID();
      const bugCode = extractShortCode(await mcpCall(adminConfiguration, uclusionToken, 'add_bug',
        { bug: `Still open ${marker}`, severity: 'BLUE' }));
      const refused = toolResult(await pollMcp('reopen', { short_code_id: bugCode }));
      assert.strictEqual(refused?.isError, true, `Reopening an open bug must be refused: ${JSON.stringify(refused)}`);
    }).timeout(300000);
  });
}
