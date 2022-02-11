import assert from 'assert';
import {getMessages, loginUserToAccount, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
  const planningMarket = {
    name: 'agile planning',
    description: 'this is an agile planning market',
    market_type: 'PLANNING',
    investment_expiration: 1,
  };
  const storyTemplate = {
    name: 'Test planning',
    description: 'Lorem Ipsum',
  };
  describe('#test plan specific actions', () => {
    it('should let a non assignable person vote', async () => {
      let adminClient;
      let notFollowingClient;
      let adminUserId;
      let notFollowingUserId;
      let notFollowingExternalId;
      let adminExternalId;
      let marketId;
      let storyId;
      let marketCapability;
      const promise = loginUserToAccount(adminConfiguration);
      await promise.then((client) => {
        adminClient = client;
        return adminClient.markets.createMarket(planningMarket);
      }).then((result) => {
        marketId = result.market.id;
        marketCapability = result.market.invite_capability;
        return loginUserToMarketInvite(userConfiguration, result.market.invite_capability);
      }).then((client) => {
        notFollowingClient = client;
        return notFollowingClient.users.get();
      }).then((me) => {
        notFollowingUserId = me.id;
        notFollowingExternalId = me.external_id;
        return notFollowingClient.markets.followMarket(true);
      }).then(() => {
        return notFollowingClient.markets.listUsers();
      }).then((users) => {
        const marketPresence = users.find((user) => user.id === notFollowingUserId);
        const adminPresence = users.find((user) => user.id !== notFollowingUserId);
        adminUserId = adminPresence.id;
        adminExternalId = adminPresence.external_id
        assert(marketPresence.following === false, "Should not be following");
        assert(marketPresence.market_banned === false, "Should not be banned");
        // not following users should be able to create stories
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return notFollowingClient.investibles.create({...storyTemplate, assignments: [adminUserId],
          estimate: tomorrow});
      }).then((story) => {
        storyId = story.investible.id;
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: marketId});
      }).then(() => {
        // not following should be able to vote
        return notFollowingClient.markets.updateInvestment(storyId, 100, 0, null, 1);
      }).then(() => {
        return loginUserToMarketInvite(adminConfiguration, marketCapability);
      }).then((client) => {
        adminClient = client;
        return adminClient.investibles.createComment(null, 'a todo to move', null, 'TODO');
      }).then((comment) => {
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: marketId}).then(() => comment);
      }).then((comment) => {
        return adminClient.investibles.moveComments(storyId, [comment.id]);
      }).then((comments) => {
        const comment = comments[0];
        assert(comment.investible_id === storyId, 'Investible id is incorrect');
        return adminClient.investibles.updateAssignments(storyId, [notFollowingUserId]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: notFollowingExternalId});
      }).then(() => {
        // This is the delete of notifications had when assigned
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: adminExternalId});
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const newVoting = messages.find(obj => {
          return obj.type_object_id === 'UNACCEPTED_ASSIGNMENT_' + storyId;
        });
        assert(newVoting, 'Mute channel still sends critical notifications');
        // This one is delayed for 1m
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: adminExternalId});
      }).then(() => {
        return getMessages(adminConfiguration);
      }).then((messages) => {
        const vote = messages.find(obj => {
          return obj.type_object_id === 'NOT_FULLY_VOTED_' + storyId;
        });
        assert(vote, 'Reassignment sends not fully voted');
        return notFollowingClient.investibles.accept(storyId);
      }).then(() => {
        // This is the delete of notifications had when assigned
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
          object_id: adminExternalId});
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const newVoting = messages.find(obj => {
          return obj.type_object_id === 'UNACCEPTED_ASSIGNMENT_' + storyId;
        });
        assert(!newVoting, 'Accepting clears unaccepted notification');
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(1200000);
  });
};

