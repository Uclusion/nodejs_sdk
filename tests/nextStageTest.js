import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, pollFor, sleep } from './commonTestFunctions.js';

// J-all-488: Next stage on a Debatable job is where the server returns it, and setting it changes that.
export default function (adminConfiguration) {
  describe('#test next stage on a Debatable job (J-all-488)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
    let stageIds;
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
        name: 'Next stage integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      stageIds = Object.fromEntries(result.stages.map((stage) => [stage.name, stage.id]));
      assert(stageIds.Doable && stageIds.Approvable, 'Planning market creation should return its stages');
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      adminClient = (await loginUserToMarketAndGetToken(adminConfiguration, marketId)).client;
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

    async function jobStage(jobCode) {
      return JSON.parse(await pollMcp('get_job', { short_code_id: jobCode, stage_only: true })).result.structuredContent.stage;
    }

    async function listMarketComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const commentVersions = new Map();
      (versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          commentVersions.set(version.object_id_one,
            Math.max(commentVersions.get(version.object_id_one) || 0, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return adminClient.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    // add_job returns only a short code, so the job's id comes from a comment on it.
    async function jobIdFromComment(marker) {
      const comments = await pollFor(() => listMarketComments(),
        (fetched) => fetched.some((comment) => comment.body?.includes(marker)));
      const jobId = comments.find((comment) => comment.body?.includes(marker))?.investible_id;
      assert(jobId, `No job found for the comment ${marker}`);
      return jobId;
    }

    async function approvableJob(marker) {
      const jobCode = extractShortCode(await mcpCall(adminConfiguration, uclusionToken, 'add_job', {
        name: `Next stage job ${marker}`, description: 'A job that waits on a question.'
      }));
      const from = await jobStage(jobCode);
      if (from !== 'Approvable') {
        await pollMcp('change_job_stage', { job_id: jobCode, from_stage: from, stage: 'Approvable' });
      }
      return jobCode;
    }

    it('returns the job to the next stage chosen while it is Debatable', async () => {
      const marker = randomUUID();
      const jobCode = await approvableJob(marker);
      const questionMarker = `Which way ${marker}?`;
      const questionCode = extractShortCode(await mcpCall(adminConfiguration, uclusionToken, 'ask_question',
        { job_id: jobCode, question: questionMarker }));
      assert.strictEqual(await pollFor(() => jobStage(jobCode), (stage) => stage === 'Requires Input'),
        'Requires Input', 'An open AI question should make the Approvable job Debatable');

      const jobId = await jobIdFromComment(questionMarker);
      await adminClient.investibles.updateFormerStage(jobId, stageIds.Doable);
      await pollMcp('resolve', { short_code_id: questionCode });

      assert.strictEqual(await pollFor(() => jobStage(jobCode), (stage) => stage === 'Doable'), 'Doable',
        'Resolving the last question should return the job to the next stage chosen, not Approvable');
    }).timeout(300000);

    it('refuses a next stage on a job that is not Debatable', async () => {
      const marker = randomUUID();
      const jobCode = await approvableJob(marker);
      const taskMarker = `A task to find the job by ${marker}`;
      await mcpCall(adminConfiguration, uclusionToken, 'add_task', { job_id: jobCode, task: taskMarker });
      const jobId = await jobIdFromComment(taskMarker);

      await assert.rejects(adminClient.investibles.updateFormerStage(jobId, stageIds.Doable),
        'A job in Approvable has no next stage to set');
    }).timeout(300000);

    it('assigns and accepts an unassigned Backlog job for the human moving it through MCP', async () => {
      const humanId = (await adminClient.users.get()).id;
      const job = await adminClient.investibles.create({
        groupId: marketId, name: `Unassigned MCP move ${randomUUID()}`,
        description: 'The authorizing human owns the job when it enters Doable.'
      });
      const createdInfo = job.market_infos.find((info) => info.market_id === marketId);
      async function currentInfo() {
        const rows = await adminClient.markets.getMarketInvestibles([{
          investible: { id: job.investible.id, version: 1 },
          market_infos: [{ id: createdInfo.id, version: 1 }]
        }]);
        return rows[0]?.market_infos.find((info) => info.market_id === marketId);
      }
      const before = await pollFor(currentInfo, (info) => Boolean(info?.ticket_code));
      assert.strictEqual(before.stage, stageIds.Backlog, 'The job must start in Backlog');
      assert.strictEqual(before.assigned?.length || 0, 0, 'The job must start unassigned');

      await mcpCall(adminConfiguration, uclusionToken, 'change_job_stage', {
        job_id: before.ticket_code, from_stage: 'Backlog', stage: 'Doable'
      });
      const after = await pollFor(currentInfo, (info) => info?.stage === stageIds.Doable);
      assert.strictEqual(after.stage, stageIds.Doable);
      assert.deepStrictEqual(after.assigned, [humanId]);
      assert.deepStrictEqual(after.accepted, [humanId]);
    }).timeout(300000);
  });
}
