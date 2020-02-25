import assert from 'assert';
import { getMessages, loginUserToAccount, loginUserToMarket } from "../src/utils";
import { arrayEquals, checkStages, sleep } from "./commonTestFunctions";

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
      const promise = loginUserToAccount(adminConfiguration);
      await promise.then((client) => {
        adminClient = client;
        return adminClient.markets.createMarket(planningMarket);
      }).then((result) => {
        marketId = result.market.id;
        return loginUserToMarket(userConfiguration, marketId);
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
        // unassignable users should be able to create users
        return nonAssignableClient.investibles.create(storyTemplate.name, storyTemplate.description, [], [adminUserId]);
      }).then((story) => {
        storyId = story.investible.id;
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: storyId});
      }).then(() => {
        // unassignable should be able to vote
        return nonAssignableClient.markets.updateInvestment(storyId, 100, 0, null, 1);
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(30000);
  });
};

