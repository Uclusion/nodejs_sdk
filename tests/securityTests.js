import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, loginUserToMarketInvite} from "../src/utils.js";

/**
 THe only security related thing we have that's not explicitly taken care
 of in our model is banning from the market.
 **/
export default function (adminConfiguration, userConfiguration) {
  const planningMarket = {
    name: 'Company A',
    market_type: 'PLANNING'
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
        }, 30000);
      }).then(() => {
        return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
      }).then((admin) => {
        adminClient = admin;
        return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
      }).then((client) => {
        bannedClient = client;
        return bannedClient.users.get();
      }).then((user) => {
        bannedUserId = user.id;
        return adminClient.users.banUser(bannedUserId, true);
      }).then((marketPresence) => {
        assert.strictEqual(marketPresence.market_banned, true, 'Ban response should mark the user banned');
        return assert.rejects(
          () => loginUserToMarket(userConfiguration, createdMarketId),
          (error) => error && error.status === 410,
          'A banned user should receive a 410 when logging into the market');
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(120000);
  });
};

