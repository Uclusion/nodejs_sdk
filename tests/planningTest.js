import assert from 'assert';
import {getMessages, loginUserToAccount, loginUserToMarketInvite} from "../src/utils.js";
import {pollFor} from "./commonTestFunctions.js";

export default function (adminConfiguration, userConfiguration) {
  describe('#test plan specific actions', () => {
    it('should let a non assignable person vote', async () => {
      let adminClient;
      let userClient;
      let adminUserId;
      let userId;
      let adminExternalId;
      let marketId;
      let storyId;
      let storyMarketInfoId;
      let marketCapability;
      const promise = loginUserToAccount(adminConfiguration);
      await promise.then((client) => {
        adminClient = client;
        const planningMarket = {
          name: 'Company B',
          market_type: 'PLANNING'
        };
        return adminClient.markets.createMarket(planningMarket);
      }).then((result) => {
        marketId = result.market.id;
        const marketPresence = result.presence;
        assert(marketPresence && marketPresence.market_banned !== true, "Should exist and not be banned");
        adminUserId = marketPresence.id;
        marketCapability = result.market.invite_capability;
        return loginUserToMarketInvite(userConfiguration, result.market.invite_capability);
      }).then((client) => {
        userClient = client;
        return client.users.get();
      }).then((me) => {
        userId = me.id;
        return userClient.markets.listUsers([{id: adminUserId, version: 1}, {id: userId, version: 1}]);
      }).then((users) => {
        const marketPresence = users.find((user) => user.id === userId);
        const adminPresence = users.find((user) => user.id !== userId);
        adminExternalId = adminPresence.external_id;
        assert(marketPresence.market_banned === false, "Should not be banned");
        // not following users should be able to create stories
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const storyOptions = {
          name: 'Test planning',
          description: 'Lorem Ipsum',
          assignments: [adminUserId],
          estimate: tomorrow,
          groupId: marketId,
        };
        return userClient.investibles.create(storyOptions);
      }).then((story) => {
        storyId = story.investible.id;
        storyMarketInfoId = story.market_infos[0].id;
        // B-all-543: poll the versioned projection used by the next operation rather
        // than registering a websocket waiter after creation has already returned.
        return pollFor(
          () => userClient.markets.getMarketInvestibles([{
            investible: {id: storyId, version: 1},
            market_infos: [{id: storyMarketInfoId, version: 1}]
          }]),
          (stories) => {
            const createdStory = stories && stories.find((candidate) =>
              candidate.investible.id === storyId);
            const marketInfo = createdStory && createdStory.market_infos.find((candidate) =>
              candidate.id === storyMarketInfoId && candidate.market_id === marketId);
            return Boolean(createdStory && marketInfo);
          });
      }).then((stories) => {
        const createdStory = stories && stories.find((candidate) =>
          candidate.investible.id === storyId);
        const marketInfo = createdStory && createdStory.market_infos.find((candidate) =>
          candidate.id === storyMarketInfoId && candidate.market_id === marketId);
        assert(createdStory && marketInfo, 'Created planning story was not readable');
        // not following should be able to vote
        return userClient.markets.updateInvestment(storyId, 100, 0);
      }).then((investment) => {
        assert(investment.quantity === 100, 'Initial planning investment should be 100');
        // B-all-543: confirm the first vote through its authoritative capability row,
        // which also avoids leaving a five-minute waiter armed across later tests.
        return pollFor(
          () => userClient.markets.listInvestments(userId, [{
            type_object_id: `investible_${storyMarketInfoId}`,
            version: 1
          }]),
          (investments) => investments && investments.some((candidate) =>
            candidate.investible_id === storyId && candidate.quantity === 100 &&
              candidate.deleted === false));
      }).then((investments) => {
        const initialInvestment = investments && investments.find((candidate) =>
          candidate.investible_id === storyId && candidate.quantity === 100 &&
            candidate.deleted === false);
        assert(initialInvestment, 'Initial planning investment was not readable');
        return loginUserToMarketInvite(adminConfiguration, marketCapability);
      }).then((client) => {
        adminClient = client;
        return adminClient.investibles.createComment(null, marketId, 'a todo to move', null, 'TODO');
      }).then((comment) => {
        // B-all-534: poll the versioned comment read used by the next operation rather
        // than using a websocket event as a proxy for readiness.
        return pollFor(
          () => adminClient.investibles.getMarketComments([{id: comment.id, version: comment.version || 1}]),
          (comments) => comments && comments.some((candidate) =>
            candidate.id === comment.id && candidate.comment_type === 'TODO')
        ).then((comments) => {
          assert(comments && comments.some((candidate) =>
              candidate.id === comment.id && candidate.comment_type === 'TODO'),
            'Created TODO was not readable before move');
          return comment;
        });
      }).then((comment) => {
        return adminClient.investibles.moveComments(storyId, [comment.id]);
      }).then((comments) => {
        const comment = comments[0];
        assert(comment.investible_id === storyId, 'Investible id is incorrect');
        // First subscribe user to group or not allowed to assign to user
        return adminClient.markets.followGroup(marketId, [{user_id: userId, is_following: true}]);
      }).then(() => {
        return adminClient.investibles.updateAssignments(storyId, [userId]);
      }).then(() => {
        return pollFor(() => getMessages(userConfiguration), (messages) =>
          messages.some((obj) =>
            obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId));
      }).then((messages) => {
        const newAssignment = messages.find(obj => {
          return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId;
        });
        assert(newAssignment, 'New assigned gets approve notification');
        // The reassignment's removal of the old assignee's request is a separate async leg
        // from the user-side generation just confirmed, so poll instead of one-shot (B-all-520)
        return pollFor(() => getMessages(adminConfiguration), (messages) =>
          !messages.some((obj) =>
            obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId));
      }).then((messages) => {
        const vote = messages.find(obj => {
          return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId;
        });
        assert(!vote, 'Updater does not get vote request');
        return userClient.markets.updateInvestment(storyId, 100, 0);
      }).then((investment) => {
        assert(investment.quantity === 100, 'Accepting planning investment should be 100');
        // The notification was observed above, so its removal is an exact positive
        // completion check for the accepting vote (B-all-520, B-all-543).
        return pollFor(() => getMessages(userConfiguration), (messages) =>
          !messages.some((obj) =>
            obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId));
      }).then((messages) => {
        const newAssignment = messages.find(obj => {
          return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId;
        });
        assert(!newAssignment, 'Accepting clears approve notification');
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(1200000);
  });
};
