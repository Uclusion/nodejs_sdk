import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, loginUserToMarketInvite} from "../src/utils";

/**
 THe only security related thing we have that's not explicitly taken care
 of in our model is banning from the market.
 **/
module.exports = function (adminConfiguration, userConfiguration) {
  const planningMarket = {
    name: 'agile planning',
    description: 'this is an agile planning market',
    market_type: 'PLANNING',
    investment_expiration: 1,
  };

  describe('#create, add, ban the user', () => {
    it('should not let a banned person login', async () => {
      let adminClient;
      let bannedClient;
      let promise = loginUserToAccount(adminConfiguration);
      let bannedUserId;
      let createdMarketId;
      let createdMarketInvite;
      await promise.then((client) => {
        adminClient = client;
        return client.markets.createMarket(planningMarket);
      }).then((response) => {
        createdMarketId = response.market.id;
        createdMarketInvite = response.market.invite_capability;
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({
          event_type: 'market',
          object_id: createdMarketId
        });
      }).then(() => {
        return loginUserToMarket(adminConfiguration, createdMarketId);
      }).then((admin) => {
        adminClient = admin;
        return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
      }).then((client) => {
        bannedClient = client;
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_capability', object_id: createdMarketId});
      }).then(() => {
        return bannedClient.users.get();
      }).then((user) => {
        bannedUserId = user.id;
        return adminClient.users.banUser(bannedUserId, true);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_capability', object_id: createdMarketId});
      }).then(() => {
        return loginUserToMarket(userConfiguration, createdMarketId)
          .then(() => {
            assert(false, "This should have failed");
            return Promise.resolve(false);
          }).catch(() => {
            return Promise.resolve(true);
          });
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(60000);
  });
};




