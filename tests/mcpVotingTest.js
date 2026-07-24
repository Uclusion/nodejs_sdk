import assert from 'assert';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarket,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration, userConfiguration) {
  describe('#test mcp voting and author rights', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let userClient;
    let marketId;
    let adminId;
    let userId;
    let uclusionToken;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps these in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      if (!userConfiguration.idToken) {
        userConfiguration.idToken = await loginUserToIdentity(userConfiguration);
      }
      const response = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = response.client;
      accountToken = response.accountToken;
      const result = await accountClient.markets.createMarket({ name: 'MCP voting',
        market_type: 'PLANNING' });
      marketId = result.market.id;
      adminClient = await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const adminUser = await adminClient.users.get();
      adminId = adminUser.id;
      userClient = await loginUserToMarketInvite(userConfiguration, result.market.invite_capability);
      const user = await userClient.users.get();
      userId = user.id;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
    });

    // Backend effects propagate async so poll until the expected state or time runs out and the
    // caller's assert reports what is still wrong
    async function pollFor(fetcher, isDone) {
      let result = await fetcher();
      for (let i = 0; i < 20 && !isDone(result); i += 1) {
        await sleep(3000);
        result = await fetcher();
      }
      return result;
    }

    // The AI user is created async on market creation so retry the MCP call until it works
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

    // Membership in an inline market is granted async so retry the login until it works
    async function pollLogin(configuration, inlineMarketId) {
      for (let i = 0; i < 19; i += 1) {
        try {
          return await loginUserToMarket(configuration, inlineMarketId);
        } catch (error) {
          await sleep(3000);
        }
      }
      return loginUserToMarket(configuration, inlineMarketId);
    }

    async function getTicketCode(client, investibleId, marketInfoId) {
      const fetcher = async () => {
        const investibles = await client.markets.getMarketInvestibles(
          [{ investible: { id: investibleId, version: 1 }, market_infos: [{ id: marketInfoId, version: 1 }] }]);
        return investibles?.[0]?.market_infos?.[0]?.ticket_code;
      };
      const ticketCode = await pollFor(fetcher, (code) => code);
      assert(ticketCode, `Ticket code missing for ${investibleId}`);
      return ticketCode;
    }

    // A question with an inline single vote decision market holding two approvable options
    async function makeVotingQuestion(body) {
      const question = await adminClient.investibles.createComment(undefined, marketId, body,
        null, 'QUESTION');
      const inlineMarket = await accountClient.markets.createMarket({ market_type: 'DECISION',
        parent_comment_id: question.id });
      const inlineMarketId = inlineMarket.market.id;
      const inlineUserClient = await pollLogin(userConfiguration, inlineMarketId);
      const inlineAdminClient = await loginUserToMarket(adminConfiguration, inlineMarketId);
      const proposedStage = inlineMarket.stages.find((stage) => stage.name === 'Proposed');
      const approvableStage = inlineMarket.stages.find((stage) => stage.name === 'Approvable');
      const options = [];
      for (const name of ['First option', 'Second option']) {
        const option = await inlineUserClient.investibles.create({ groupId: inlineMarketId, name,
          description: `${name} of the voting question.` });
        const optionId = option.investible.id;
        const marketInfoId = option.market_infos[0].id;
        await inlineAdminClient.investibles.stateChange(optionId, { current_stage_id: proposedStage.id,
          stage_id: approvableStage.id });
        options.push({ id: optionId, marketInfoId,
          ticketCode: option.market_infos[0].ticket_code ||
            await getTicketCode(inlineAdminClient, optionId, marketInfoId) });
      }
      return { question, inlineMarketId, inlineUserClient, inlineAdminClient,
        optionA: options[0], optionB: options[1] };
    }

    // Investments key off the market info id, not the investible id (see users_invest range key)
    async function getInvestment(client, ownerId, option) {
      const investments = await client.markets.listInvestments(ownerId,
        [{ type_object_id: `investible_${option.marketInfoId}`, version: 1 }]);
      return (investments || []).find((investment) => investment.investible_id === option.id);
    }

    function isLiveInvestment(investment) {
      return !!investment && !investment.deleted &&
        (investment.quantity === undefined || investment.quantity > 0);
    }

    it('should move AI vote via MCP approval on single vote question', async () => {
      const { question, inlineAdminClient, optionA, optionB } = await makeVotingQuestion(
        'Does the AI vote move on second approval?');
      await pollMcp('approve_job_or_option',
        { job_or_option_id: optionA.ticketCode, parent_question_short_code_id: question.ticket_code,
          certainty: 3 });
      // The moderator's new vote notification carries the AI user id as its suffix
      const voteMessage = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) =>
          message.type_object_id?.startsWith(`UNREAD_VOTE_${optionA.id}_`));
      }, (message) => message);
      assert(voteMessage, 'MCP approval should notify the question creator of the AI vote');
      const aiUserId = voteMessage.type_object_id.substring(`UNREAD_VOTE_${optionA.id}_`.length);
      const firstVote = await pollFor(() => getInvestment(inlineAdminClient, aiUserId, optionA),
        isLiveInvestment);
      assert(isLiveInvestment(firstVote), 'MCP approval should invest the AI user in the first option');
      await pollMcp('approve_job_or_option',
        { job_or_option_id: optionB.ticketCode, parent_question_short_code_id: question.ticket_code,
          certainty: 4 });
      const moved = await pollFor(async () => {
        return { a: await getInvestment(inlineAdminClient, aiUserId, optionA),
          b: await getInvestment(inlineAdminClient, aiUserId, optionB) };
      }, (votes) => !isLiveInvestment(votes.a) && isLiveInvestment(votes.b));
      assert(isLiveInvestment(moved.b), 'AI vote should be live on the second option');
      assert(!isLiveInvestment(moved.a),
        'MCP approval should move the AI vote off the first option instead of duplicating per C-all-1168');
    }).timeout(240000);

    it('should move user vote via normal invest on single vote question', async () => {
      const { inlineUserClient, optionA, optionB } = await makeVotingQuestion(
        'Does the normal path move the vote?');
      await inlineUserClient.markets.updateInvestment(optionA.id, 100, 0);
      const firstVote = await pollFor(() => getInvestment(inlineUserClient, userId, optionA),
        isLiveInvestment);
      assert(isLiveInvestment(firstVote), 'Normal invest should record the first vote');
      await inlineUserClient.markets.updateInvestment(optionB.id, 100, 0);
      const moved = await pollFor(async () => {
        return { a: await getInvestment(inlineUserClient, userId, optionA),
          b: await getInvestment(inlineUserClient, userId, optionB) };
      }, (votes) => !isLiveInvestment(votes.a) && isLiveInvestment(votes.b));
      assert(isLiveInvestment(moved.b), 'User vote should be live on the second option');
      assert(!isLiveInvestment(moved.a), 'Normal path should move the vote off the first option');
    }).timeout(240000);

    it('should give anyone author rights on an AI authored question', async () => {
      const job = await adminClient.investibles.create({ groupId: marketId, name: 'Author rights job',
        description: 'Job to hang the AI authored question on.' });
      const jobTicket = job.market_infos[0].ticket_code ||
        await getTicketCode(adminClient, job.investible.id, job.market_infos[0].id);
      const marker = 'AI authored question for rights test?';
      const mcpResult = await mcpCall(adminConfiguration, uclusionToken, 'ask_question',
        { job_id: jobTicket, question: marker,
          options: [{ name: 'First direction', description: 'One way to go.' },
            { name: 'Second direction', description: 'Another way to go.' }] });
      assert(mcpResult.includes('Added question with id'), `MCP ask_question response wrong: ${mcpResult}`);
      // Discover the created comment through versions since MCP only returns short codes
      const questionComment = await pollFor(async () => {
        const versions = await accountClient.summaries.versions(accountToken, [marketId]);
        const marketEntry = (versions.signatures || []).find((entry) => entry.market_id === marketId);
        const commentIds = (marketEntry?.signatures || [])
          .filter((signature) => signature.type === 'comment')
          .flatMap((signature) => (signature.object_versions || []).map((version) => version.object_id_one));
        if (commentIds.length === 0) {
          return undefined;
        }
        const comments = await adminClient.investibles.getMarketComments(
          [...new Set(commentIds)].map((id) => ({ id, version: 1 })));
        return (comments || []).find((comment) => comment.body?.includes(marker));
      }, (comment) => comment?.inline_market_id);
      assert(questionComment, 'AI authored question should be discoverable');
      assert(questionComment.created_by !== adminId && questionComment.created_by !== userId,
        'Question should be authored by the AI user');
      // Change the settings as a non author - red here means C-all-1167 is a back end problem
      await adminClient.investibles.updateComment(questionComment.id, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, true);
      const inlineMarketId = questionComment.inline_market_id;
      const inlineAdminClient = await pollLogin(adminConfiguration, inlineMarketId);
      const inlineMarket = await pollFor(() => inlineAdminClient.markets.get(),
        (market) => market.allow_multi_vote === true);
      assert(inlineMarket.allow_multi_vote === true,
        'Non author settings change should flip allow multi vote on the inline market');
      // Move an option stage as a non author
      const inlineVersions = await accountClient.summaries.versions(accountToken, [inlineMarketId]);
      const inlineEntry = (inlineVersions.signatures || []).find((entry) => entry.market_id === inlineMarketId);
      const stageIds = (inlineEntry?.signatures || [])
        .filter((signature) => signature.type === 'stage')
        .flatMap((signature) => (signature.object_versions || []).map((version) => version.object_id_one));
      const stages = await inlineAdminClient.markets.listStages(stageIds.map((id) => ({ id, version: 1 })));
      const proposedStage = stages.find((stage) => stage.name === 'Proposed');
      const approvableStage = stages.find((stage) => stage.name === 'Approvable');
      assert(proposedStage && approvableStage, 'Inline market should have Proposed and Approvable stages');
      const optionIds = (inlineEntry?.signatures || [])
        .filter((signature) => signature.type === 'investible')
        .flatMap((signature) => (signature.object_versions || []).map((version) => version.object_id_one));
      assert(optionIds.length > 0, 'AI authored question should have discoverable options');
      // MCP created options start in the approvable stage - demote one as the non author
      await inlineAdminClient.investibles.stateChange(optionIds[0],
        { current_stage_id: approvableStage.id, stage_id: proposedStage.id });
    }).timeout(240000);
  });
};
