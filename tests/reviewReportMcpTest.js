import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration) {
  describe('#test review report lifecycle integration', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let adminId;
    let marketId;
    let uclusionToken;
    let stagesByName;
    let job;
    let jobTicketCode;
    let jobMarketInfoId;
    let reportCode;

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
        name: 'Review report lifecycle integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      stagesByName = Object.fromEntries(result.stages.map((stage) => [stage.name, stage]));
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      adminId = (await adminClient.users.get()).id;
      // This is the same market-scoped token used by the CLI proxy.
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);

      job = await adminClient.investibles.create({
        groupId: marketId,
        name: 'Job whose review survives an excursion',
        description: 'A question asked during review must not end the review round.',
        assignments: [adminId]
      });
      jobTicketCode = await getTicketCode(job);
      const createdInfo = job.market_infos.find((info) => info.market_id === marketId)
        || job.market_infos[0];
      jobMarketInfoId = createdInfo.id;
      if (createdInfo.stage !== stagesByName.Doable.id) {
        await adminClient.investibles.stateChange(job.investible.id, {
          current_stage_id: createdInfo.stage,
          stage_id: stagesByName.Doable.id
        });
        await pollFor(currentStageId, (stage) => stage === stagesByName.Doable.id);
      }
    });

    // Backend effects propagate async so poll until the expected state or time runs out and the
    // caller's assert reports what is still wrong.
    async function pollFor(fetcher, isDone) {
      let result = await fetcher();
      for (let i = 0; i < 20 && !isDone(result); i += 1) {
        await sleep(3000);
        result = await fetcher();
      }
      return result;
    }

    // The AI user is created async on market creation, so retry the MCP call until it works.
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

    async function getTicketCode(investible) {
      const marketInfo = investible.market_infos[0];
      if (marketInfo.ticket_code) {
        return marketInfo.ticket_code;
      }
      const code = await pollFor(async () => {
        const fetched = await adminClient.markets.getMarketInvestibles([{
          investible: { id: investible.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        return fetched?.[0]?.market_infos?.[0]?.ticket_code;
      }, (value) => value);
      assert(code, `Ticket code missing for ${investible.investible.id}`);
      return code;
    }

    async function currentStageId() {
      const [current] = await adminClient.markets.getMarketInvestibles([{
        investible: { id: job.investible.id, version: 1 },
        market_infos: [{ id: jobMarketInfoId, version: 1 }]
      }]);
      const info = (current?.market_infos || []).find((entry) => entry.market_id === marketId)
        || current?.market_infos?.[0];
      return info?.stage;
    }

    async function listComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === marketId);
      const commentVersions = new Map();
      (marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const current = commentVersions.get(version.object_id_one) || 0;
          commentVersions.set(version.object_id_one, Math.max(current, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return adminClient.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    async function findCommentByMarker(marker) {
      const comments = await pollFor(
        () => listComments(),
        (fetched) => fetched.some((comment) => comment.body?.includes(marker))
      );
      return comments.find((comment) => comment.body?.includes(marker));
    }

    it('should keep the review report open through a Requires Input excursion', async () => {
      const marker = randomUUID();
      const reportMarker = `Review round report ${marker}`;
      const reviewResult = await pollMcp('ask_for_review', {
        job_id: jobTicketCode,
        report: reportMarker
      });
      assert(reviewResult.includes('Added report with id'),
        `MCP ask_for_review response wrong: ${reviewResult}`);
      const reviewableStage = await pollFor(currentStageId,
        (stage) => stage === stagesByName.Reviewable.id);
      assert.strictEqual(reviewableStage, stagesByName.Reviewable.id,
        'ask_for_review should move the job to Reviewable');
      const report = await findCommentByMarker(reportMarker);
      assert(report?.ticket_code, 'The review report should be durable with a short code');
      assert.notStrictEqual(report.resolved, true, 'A fresh report must be open');
      reportCode = report.ticket_code;

      const questionMarker = `Question during review ${marker}?`;
      const questionResult = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: questionMarker
      });
      assert(questionResult.includes('Added question with id'),
        `MCP ask_question response wrong: ${questionResult}`);
      const requiresInputStage = await pollFor(currentStageId,
        (stage) => stage === stagesByName['Requires Input'].id);
      assert.strictEqual(requiresInputStage, stagesByName['Requires Input'].id,
        'An open AI question should move the reviewed job to Requires Input');
      // The old defect resolved the report during this exact transition, so give
      // its async processing time to run before asserting the report survived.
      await sleep(6000);
      const reportDuringExcursion = await findCommentByMarker(reportMarker);
      assert.notStrictEqual(reportDuringExcursion.resolved, true,
        'The review report must survive the Requires Input excursion');

      const question = await findCommentByMarker(questionMarker);
      assert(question?.ticket_code, 'The AI question should be durable with a short code');
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        `Answer letting the AI resume the review ${marker}.`,
        question.id
      );
      const resolveResult = await pollMcp('resolve', { short_code_id: question.ticket_code });
      assert(resolveResult.includes('Resolved'),
        `MCP resolve response wrong: ${resolveResult}`);
      const restoredStage = await pollFor(currentStageId,
        (stage) => stage === stagesByName.Reviewable.id);
      assert.strictEqual(restoredStage, stagesByName.Reviewable.id,
        'Clearing the excursion should restore the job to Reviewable');
      const reportAfterExcursion = await findCommentByMarker(reportMarker);
      assert.notStrictEqual(reportAfterExcursion.resolved, true,
        'The restored review round must still have its open report');
    }).timeout(300000);

    it('should refuse updating a resolved report with a descriptive tool error', async () => {
      assert(reportCode, 'The excursion test must have produced the report short code');
      const resolveResult = await pollMcp('resolve', { short_code_id: reportCode });
      assert(resolveResult.includes('Resolved'),
        `MCP resolve response wrong: ${resolveResult}`);
      const refusal = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'ask_for_review', {
          update_review_short_code_id: reportCode,
          report: 'Rewrite that must be refused because the report is resolved.'
        }),
        (response) => response.includes('no longer accepts')
      );
      assert(refusal.includes('resolved report') && refusal.includes('no longer accepts'),
        `Resolved-report update should explain the refusal: ${refusal}`);
      assert(refusal.includes('ask_for_review') && refusal.includes('job_id'),
        `The refusal should name the corrective action: ${refusal}`);
      assert(refusal.includes('"isError":true'),
        `The refusal should be a tool error result: ${refusal}`);
    }).timeout(240000);
  });
}
