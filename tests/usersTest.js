import assert from 'assert';
import uclusion from 'uclusion_sdk';
import TestTokenManager, { TOKEN_TYPE_ACCOUNT } from '../src/TestTokenManager';
import {
  getSSOInfo,
  loginUserToAccount,
  getWebSocketRunner,
  loginUserToMarketInvite
} from '../src/utils';

/*
Admin Configuration and User Configuration are used as in/out params here,
so that we don't have to keep making accounts for every seperate test
 */
module.exports = function (adminConfiguration, userConfiguration) {
  describe('#doCreate account and update user', () => {
    it('should login and pull without error', async () => {
      let adminAccountClient;
      const date = new Date();
      const timestamp = date.getTime();
      let adminIdToken;
      let ssoClient;
      let createdMarketId;
      let adminClient;
      let createdMarketInvite;
      await getSSOInfo(adminConfiguration).then(ssoInfo => {
        ssoClient = ssoInfo.ssoClient;
        adminIdToken = ssoInfo.idToken;
        return getWebSocketRunner(adminConfiguration);
      }).then((webSocketRunner) => {
        adminConfiguration.webSocketRunner = webSocketRunner;
        return getWebSocketRunner(userConfiguration);
      }).then((webSocketRunner) => {
        userConfiguration.webSocketRunner = webSocketRunner;
        const info = {
          name: 'Test UserAdmin',
          email: adminConfiguration.username,
          password: adminConfiguration.password,
          phone: '555-555-1212'
        };
        return ssoClient.userSignup(info);
      }).then((result) => {
        assert(result.response === 'ACCOUNT_EXISTS', 'Account should have existed');
        return ssoClient.resendVerification(adminConfiguration.username);
      }).then((result) => {
        assert(result.response === 'ACCOUNT_EXISTS', 'Account should have existed');
        const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
        const config = { ...adminConfiguration, tokenManager };
        return uclusion.constructClient(config);
      }).then((client) => {
        adminAccountClient = client;
        return adminAccountClient.users.update({'name': 'Daniel', 'uiPreferences': '{ "code": "red" }'});
      }).then((user) => {
        assert(user.name === 'Daniel', 'User update was not successful');
        return adminAccountClient.users.get(adminConfiguration.userId);
      }).then((user) => {
        assert(user.name === 'Daniel', 'Name not updated properly');
        assert(user.ui_preferences === '{ "code": "red" }', 'UI preferences not updated properly');
        return loginUserToAccount(adminConfiguration);
      }).then((client) => {
        const marketOptions = {
          name: 'Company A',
          market_type: 'PLANNING'
        };
        return client.markets.createMarket(marketOptions);
      }).then((response) => {
        createdMarketId = response.market.id;
        createdMarketInvite = response.market.invite_capability;
        return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
      }).then((client) => {
        adminClient = client;
        return adminAccountClient.users.update({'name': 'Default',
          'notification_config': {
            'market_id': createdMarketId,
            'is_slack_addressable': true
          }});
      }).then((user) => {
        assert(user.name === 'Default', 'Update name not successful');
        assert(user.notification_configs.length === 1, 'Config missing');
        assert(user.notification_configs[0].market_id === createdMarketId, 'Update config not successful');
        assert(user.notification_configs[0].is_slack_addressable, 'Update slack addressable not successful');
        // Add placeholder user to the market
        return adminClient.users.inviteUsers([userConfiguration.username]);
      }).then(() => {
        // This should be the user pushed out
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_capability',
          object_id: createdMarketId});
      }).then(() => {
        return adminClient.markets.listUsers();
      }).then((users) => {
        const addedUser = users.find(obj => {
          return obj.email === userConfiguration.username;
        });
        assert(addedUser, 'Did not find user');
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(60000);
  });


};
