import assert from 'assert';
import {
  getMessages,
  loginUserToAccount,
  loginUserToIdentity,
  loginUserToMarket,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration, userConfiguration) {
  describe('#test resolve question notification cleanup', () => {
    let accountClient;
    let adminClient;
    let userClient;
    let marketId;
    let userId;

    before(async function () {
      this.timeout(300000);
      // Normally identityTests and usersTest seed the idTokens - do it here so this file can run by itself
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      if (!userConfiguration.idToken) {
        userConfiguration.idToken = await loginUserToIdentity(userConfiguration);
      }
      accountClient = await loginUserToAccount(adminConfiguration);
      const result = await accountClient.markets.createMarket({ name: 'Resolve notifications',
        market_type: 'PLANNING' });
      marketId = result.market.id;
      adminClient = await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      userClient = await loginUserToMarketInvite(userConfiguration, result.market.invite_capability);
      const user = await userClient.users.get();
      userId = user.id;
    });

    // Notification create and delete propagate async so poll until the expected state or time runs
    // out and the caller's assert reports what is still wrong
    async function pollMessages(configuration, isDone) {
      let messages = (await getMessages(configuration)) || [];
      for (let i = 0; i < 20 && !isDone(messages); i += 1) {
        await sleep(3000);
        messages = (await getMessages(configuration)) || [];
      }
      return messages;
    }

    function findMessage(messages, typeObjectId) {
      return messages.find((message) => message.type_object_id === typeObjectId);
    }

    async function assertNotificationArrives(configuration, typeObjectId, label) {
      const messages = await pollMessages(configuration, (fetched) => findMessage(fetched, typeObjectId));
      assert(findMessage(messages, typeObjectId), `${label} should send ${typeObjectId}`);
    }

    async function assertNotificationRemoved(configuration, typeObjectId, label) {
      const messages = await pollMessages(configuration, (fetched) => !findMessage(fetched, typeObjectId));
      assert(!findMessage(messages, typeObjectId), `${label} should remove ${typeObjectId}`);
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

    it('should remove reply notification when creator resolves question', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'Reply cleanup question?', null, 'QUESTION');
      const reply = await userClient.investibles.createComment(undefined, marketId, 'a reply',
        question.id);
      await assertNotificationArrives(adminConfiguration, `UNREAD_REPLY_${reply.id}`, 'reply to question');
      await adminClient.investibles.updateComment(question.id, undefined, true);
      await assertNotificationRemoved(adminConfiguration, `UNREAD_REPLY_${reply.id}`, 'creator resolving');
    }).timeout(240000);

    it('should remove reply notification for creator when replier resolves question', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'Replier resolves question?', null, 'QUESTION');
      const reply = await userClient.investibles.createComment(undefined, marketId, 'a reply',
        question.id);
      await assertNotificationArrives(adminConfiguration, `UNREAD_REPLY_${reply.id}`, 'reply to question');
      await userClient.investibles.updateComment(question.id, undefined, true);
      await assertNotificationRemoved(adminConfiguration, `UNREAD_REPLY_${reply.id}`, 'replier resolving');
    }).timeout(240000);

    it('should remove resolver deep reply notification on resolve', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'Deep thread question?', null, 'QUESTION');
      const reply = await userClient.investibles.createComment(undefined, marketId, 'first level reply',
        question.id);
      const childReply = await adminClient.investibles.createComment(undefined, marketId,
        'second level reply', reply.id);
      await assertNotificationArrives(userConfiguration, `UNREAD_REPLY_${childReply.id}`, 'deeper reply');
      // Per C-all-1166 the resolver gets whole thread cleanup at any depth
      await userClient.investibles.updateComment(question.id, undefined, true);
      await assertNotificationRemoved(userConfiguration, `UNREAD_REPLY_${childReply.id}`, 'resolver resolving');
    }).timeout(240000);

    it('should keep creator deep reply notification beyond one level on resolve', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'Creator deep notification question?', null, 'QUESTION');
      const reply = await userClient.investibles.createComment(undefined, marketId, 'first level reply',
        question.id);
      const childReply = await adminClient.investibles.createComment(undefined, marketId,
        'second level reply', reply.id);
      const grandChildReply = await userClient.investibles.createComment(undefined, marketId,
        'third level reply', childReply.id);
      await assertNotificationArrives(adminConfiguration, `UNREAD_REPLY_${grandChildReply.id}`,
        'third level reply');
      await userClient.investibles.updateComment(question.id, undefined, true);
      // Per C-all-1166 the creator only gets one level deep cleanup - anchor on the resolved
      // notification arriving so the removal pass is known to have run before checking survival
      await assertNotificationArrives(adminConfiguration, `UNREAD_RESOLVED_${question.id}`,
        'replier resolving');
      const messages = (await getMessages(adminConfiguration)) || [];
      assert(findMessage(messages, `UNREAD_REPLY_${grandChildReply.id}`),
        'creator third level reply notification should survive resolve per C-all-1166');
    }).timeout(240000);

    it('should remove new option notifications when question resolved', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'Option cleanup question?', null, 'QUESTION');
      const inlineMarket = await accountClient.markets.createMarket({ market_type: 'DECISION',
        parent_comment_id: question.id });
      const inlineMarketId = inlineMarket.market.id;
      const inlineUserClient = await pollLogin(userConfiguration, inlineMarketId);
      // proposedOption stays in Proposed so its investible submitted notification survives until resolve
      const proposedOption = await inlineUserClient.investibles.create({ groupId: inlineMarketId,
        name: 'A proposed option', description: 'Stays proposed until the question resolves.' });
      const proposedOptionId = proposedOption.investible.id;
      await assertNotificationArrives(adminConfiguration, `INVESTIBLE_SUBMITTED_${proposedOptionId}`,
        'new option');
      const votedOption = await inlineUserClient.investibles.create({ groupId: inlineMarketId,
        name: 'A voted option', description: 'Promoted and voted on before the question resolves.' });
      const votedOptionId = votedOption.investible.id;
      const inlineAdminClient = await loginUserToMarket(adminConfiguration, inlineMarketId);
      const proposedStage = inlineMarket.stages.find((stage) => stage.name === 'Proposed');
      const approvableStage = inlineMarket.stages.find((stage) => stage.name === 'Approvable');
      await inlineAdminClient.investibles.stateChange(votedOptionId, { current_stage_id: proposedStage.id,
        stage_id: approvableStage.id });
      await inlineUserClient.markets.updateInvestment(votedOptionId, 100, 0);
      // This new or updated option notification is the type left behind in B-all-487
      await assertNotificationArrives(adminConfiguration, `UNREAD_VOTE_${votedOptionId}_${userId}`,
        'vote for new option');
      await adminClient.investibles.updateComment(question.id, undefined, true);
      await assertNotificationRemoved(adminConfiguration, `INVESTIBLE_SUBMITTED_${proposedOptionId}`,
        'resolving question with inline market');
      await assertNotificationRemoved(adminConfiguration, `UNREAD_VOTE_${votedOptionId}_${userId}`,
        'resolving question with inline market');
    }).timeout(240000);

    it('should remove option thread reply notifications when question resolved', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'Option thread question?', null, 'QUESTION');
      const inlineMarket = await accountClient.markets.createMarket({ market_type: 'DECISION',
        parent_comment_id: question.id });
      const inlineMarketId = inlineMarket.market.id;
      const inlineUserClient = await pollLogin(userConfiguration, inlineMarketId);
      const inlineAdminClient = await loginUserToMarket(adminConfiguration, inlineMarketId);
      const option = await inlineAdminClient.investibles.create({ groupId: inlineMarketId,
        name: 'A threaded option', description: 'Option with a comment thread.' });
      const optionId = option.investible.id;
      const optionComment = await inlineAdminClient.investibles.createComment(optionId, inlineMarketId,
        'root comment on option', null, 'QUESTION');
      const optionReply = await inlineUserClient.investibles.createComment(optionId, inlineMarketId,
        'first level option reply', optionComment.id);
      const optionChildReply = await inlineAdminClient.investibles.createComment(optionId, inlineMarketId,
        'second level option reply', optionReply.id);
      // Deeper thread notification held in the inline market by a user who is neither creator nor resolver
      await assertNotificationArrives(userConfiguration, `UNREAD_REPLY_${optionChildReply.id}`,
        'option thread reply');
      await adminClient.investibles.updateComment(question.id, undefined, true);
      await assertNotificationRemoved(userConfiguration, `UNREAD_REPLY_${optionChildReply.id}`,
        'resolving question with option thread');
    }).timeout(240000);

    it('should remove reply notification when AI user resolves via MCP', async () => {
      const question = await adminClient.investibles.createComment(undefined, marketId,
        'MCP resolve question?', null, 'QUESTION');
      const reply = await userClient.investibles.createComment(undefined, marketId, 'a reply',
        question.id);
      await assertNotificationArrives(adminConfiguration, `UNREAD_REPLY_${reply.id}`, 'reply to question');
      const uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
      // MCP is just a post - resolve as the AI user with the question's ticket code
      const mcpResult = await mcpCall(adminConfiguration, uclusionToken, 'resolve',
        { short_code_id: question.ticket_code });
      assert(mcpResult.includes(`Resolved comment ${question.ticket_code}`),
        `MCP resolve response wrong: ${mcpResult}`);
      await assertNotificationRemoved(adminConfiguration, `UNREAD_REPLY_${reply.id}`, 'AI user resolving');
      // The AI user is a different user than the creator so the creator hears about the resolve
      await assertNotificationArrives(adminConfiguration, `UNREAD_RESOLVED_${question.id}`, 'AI user resolving');
    }).timeout(240000);
  });
};
