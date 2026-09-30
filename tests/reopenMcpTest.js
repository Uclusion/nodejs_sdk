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
      const { client: adminClient } = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
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
      const match = responseText.match(/with id ([A-Z]-[^ ]+) and link/);
      assert(match, `No short code in response: ${responseText}`);
      return match[1];
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
      const bugCode = extractShortCode(await mcpCall(adminConfiguration, uclusionToken, 'add_bug',
        { bug: `Back still fails ${marker}`, severity: 'RED' }));
      await pollMcp('resolve', { short_code_id: bugCode });
      const resolved = await pollFor(
        async () => mcpText(await pollMcp('get_job', { short_code_id: bugCode })),
        (markdown) => markdown.includes(`Resolved Bug ${bugCode}<a`));
      assert(resolved.includes(`Resolved Bug ${bugCode}<a`), `The bug should be resolved: ${resolved}`);

      const refused = toolResult(await mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
        job_id: bugCode, question: `Retry ${marker}?`, options: OPTIONS, initial_vote: VOTE
      }));
      assert.strictEqual(refused?.isError, true, `Converting a resolved bug must be refused: ${JSON.stringify(refused)}`);
      assert(JSON.stringify(refused).includes('reopen it with the reopen tool'),
        `The refusal should name the reopen tool: ${JSON.stringify(refused)}`);

      // The human reported the failure, so the reopen is theirs.
      const reopened = toolResult(await pollMcp('reopen',
        { short_code_id: bugCode, for_human: true, is_my_lane: true }));
      assert.notStrictEqual(reopened?.isError, true, JSON.stringify(reopened));
      assert.deepStrictEqual(reopened?.structuredContent, { short_code_id: bugCode, status: 'reopened' },
        JSON.stringify(reopened));
      const open = await pollFor(
        async () => mcpText(await pollMcp('get_job', { short_code_id: bugCode })),
        (markdown) => markdown.includes(`Bug ${bugCode}<a`) && !markdown.includes(`Resolved Bug ${bugCode}<a`));
      assert(!open.includes(`Resolved Bug ${bugCode}<a`), `The bug should be open again: ${open}`);

      const converted = await mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
        job_id: bugCode, question: `Retry ${marker}?`, options: OPTIONS, initial_vote: VOTE
      });
      assert.notStrictEqual(toolResult(converted)?.isError, true, converted);
      assert(mcpText(converted).includes(`moved bug ${bugCode} into it as a task`),
        `The reopened bug should convert: ${converted}`);
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
      assert(JSON.stringify(refused).includes('is already open'), JSON.stringify(refused));
    }).timeout(300000);
  });
}
