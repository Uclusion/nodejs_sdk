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
        marketCapability = result.market.invite_capability;
        return loginUserToMarketInvite(userConfiguration, result.market.invite_capability);
      }).then((client) => {
        userClient = client;
        return client.users.get();
      }).then((me) => {
        userId = me.id;
        externalId = me.external_id;
        return userClient.markets.listUsers();
      }).then((users) => {
        const marketPresence = users.find((user) => user.id === userId);
        const adminPresence = users.find((user) => user.id !== userId);
        adminUserId = adminPresence.id;
        adminExternalId = adminPresence.external_id
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
        return userClient.markets.updateInvestment(storyId, 100, 0, null, 1);
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
        return adminClient.investibles.updateAssignments(storyId, [userId]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: externalId});
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const newAssignment = messages.find(obj => {
          return obj.type_object_id === 'UNACCEPTED_ASSIGNMENT_' + storyId;
        });
        assert(newAssignment, 'Re-assigned gets unaccepted notification');
        // NOT_FULLY_VOTED is delayed for 1m to handle case of API chaining
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: adminExternalId});
      }).then(() => {
        return getMessages(adminConfiguration);
      }).then((messages) => {
        const vote = messages.find(obj => {
          return obj.type_object_id === 'NOT_FULLY_VOTED_' + storyId;
        });
        assert(vote, 'Reassignment sends not fully voted');
        const newAssignment = messages.find(obj => {
          return obj.type_object_id === 'UNACCEPTED_ASSIGNMENT_' + storyId;
        });
        assert(!newAssignment, 'Notifications from when assigned not deleted');
        return userClient.investibles.accept(storyId);
      }).then(() => {
        // This is the delete of unaccepted notification now that accepting has assigned
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: externalId});
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const newAssignment = messages.find(obj => {
          return obj.type_object_id === 'UNACCEPTED_ASSIGNMENT_' + storyId;
        });
        assert(!newAssignment, 'Accepting clears unaccepted notification');
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(1200000);
  });
};

