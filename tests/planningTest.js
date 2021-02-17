import assert from 'assert';
import {loginUserToAccount, loginUserToMarketInvite} from "../src/utils";

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
      let nonAssignableClient;
      let adminUserId;
      let nonAssignableUserId;
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
        nonAssignableClient = client;
        return nonAssignableClient.users.get();
        // become no assignable
      }).then((me) => {
        nonAssignableUserId = me.id;
        return nonAssignableClient.markets.followMarket(true);
      }).then(() => {
        return nonAssignableClient.markets.listUsers();
      }).then((users) => {
        const marketPresence = users.find((user) => user.id === nonAssignableUserId);
        const adminPresence = users.find((user) => user.id !== nonAssignableUserId);
        adminUserId = adminPresence.id;
        assert(marketPresence.following === false, "Should not be assignable");
        assert(marketPresence.market_banned === false, "Should not be banned");
        // unassignable users should be able to create users
        return nonAssignableClient.investibles.create({...storyTemplate, assignments: [adminUserId]});
      }).then((story) => {
        storyId = story.investible.id;
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: marketId});
      }).then(() => {
        // unassignable should be able to vote
        return nonAssignableClient.markets.updateInvestment(storyId, 100, 0, null, 1);
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
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(30000);
  });
};

