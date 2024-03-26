import assert from 'assert';
import uclusion from 'uclusion_sdk';
import TestTokenManager, { TOKEN_TYPE_ACCOUNT } from '../src/TestTokenManager';
import {
  getSSOInfo,
  loginUserToAccount,
  getWebSocketRunner,
  loginUserToMarketInvite, loginUserToIdentity
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
      let ssoClient;
      let createdMarketId;
      let adminClient;
      let createdMarketInvite;
      await getSSOInfo(adminConfiguration).then(ssoInfo => {
        ssoClient = ssoInfo.ssoClient;
        return getWebSocketRunner(adminConfiguration);
      }).then((webSocketRunner) => {
        adminConfiguration.webSocketRunner = webSocketRunner;
        return loginUserToIdentity(userConfiguration)
            .then((jwtToken) => {
              userConfiguration.idToken = jwtToken;
              return getWebSocketRunner(userConfiguration);
            });
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
        const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
            adminConfiguration.idToken);
        const config = { ...adminConfiguration, tokenManager };
        return uclusion.constructClient(config);
      }).then((client) => {
        adminAccountClient = client;
        return adminAccountClient.users.update({'name': 'Daniel', 'uiPreferences': '{ "code": "red" }',
          'clear_notification_configs': true});
      }).then((user) => {
        assert(user.name === 'Daniel', 'User update was not successful');
        return adminAccountClient.users.get(adminConfiguration.userId);
      }).then((user) => {
        assert(user.name === 'Daniel', 'Name not updated properly');
        assert(user.ui_preferences === '{ "code": "red" }', 'UI preferences not updated properly');
        assert(user.notification_configs === undefined, 'Notification configs not cleared');
        return loginUserToAccount(userConfiguration);
      }).then((client) => {
        // Also clear user notification configs to clean up and so can test last email sent later
        client.users.update({'clear_notification_configs': true});
        const marketOptions = {
          name: 'Company A',
          market_type: 'PLANNING'
        };
        return adminAccountClient.markets.createMarket(marketOptions);
      }).then((response) => {
        createdMarketId = response.market.id;
        createdMarketInvite = response.market.invite_capability;
        return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
      }).then((client) => {
        adminClient = client;
        return adminAccountClient.users.update({'name': 'Default',
            'marketId': createdMarketId,
            'slackEnabled': true
        });
      }).then((user) => {
        assert(user.name === 'Default', 'Update name not successful');
        const notification_config = user.notification_configs.find((config) =>
            config.market_id === createdMarketId);
        assert(notification_config.slack_enabled, 'Update slack enabled not successful');
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
