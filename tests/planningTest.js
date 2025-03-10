import assert from 'assert';
import {getMessages, loginUserToAccount, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
  describe('#test plan specific actions', () => {
    it('should let a non assignable person vote', async () => {
      let adminClient;
      let userClient;
      let adminUserId;
      let userId;
      let externalId;
      let adminExternalId;
      let marketId;
      let storyId;
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
        externalId = me.external_id;
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
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: marketId});
      }).then(() => {
        // not following should be able to vote
        return userClient.markets.updateInvestment(storyId, 100, 0);
      }).then(() => {
        return loginUserToMarketInvite(adminConfiguration, marketCapability);
      }).then((client) => {
        adminClient = client;
        return adminClient.investibles.createComment(null, marketId, 'a todo to move', null, 'TODO');
      }).then((comment) => {
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: marketId}).then(() => comment);
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
        // wait for the investment deletion event
        return adminConfiguration.webSocketRunner.waitForReceivedMessage(
            {event_type: 'investment', object_id: marketId});
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const newAssignment = messages.find(obj => {
          return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId;
        });
        assert(newAssignment, 'New assigned gets approve notification');
        return getMessages(adminConfiguration);
      }).then((messages) => {
        const vote = messages.find(obj => {
          return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + storyId;
        });
        assert(!vote, 'Updater does not get vote request');
        return userClient.markets.updateInvestment(storyId, 100, 0);
      }).then(() => {
        // Delete of unaccepted notification now that approving has accepted
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: externalId});
      }).then(() => {
        return getMessages(userConfiguration);
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

