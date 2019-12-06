import assert from 'assert';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT} from '../src/TestTokenManager';
import {getSSOInfo, loginUserToAccount, loginUserToMarket, getWebSocketRunner} from '../src/utils';

/*
Admin Configuration and User Configuration are used as in/out params here,
so that we don't have to keep making accounts for every seperate test
 */
module.exports = function (adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 20
    };
    describe('#doCreate account and update user', () => {
        it('should login and pull without error', async () => {
            let adminAccountClient;
            const date = new Date();
            const timestamp = date.getTime();
            const accountName = 'TestAccount' + timestamp;
            let adminIdToken;
            let ssoClient;
            let createdMarketId;
            let adminClient;
            await getSSOInfo(adminConfiguration).then(ssoInfo => {
                    ssoClient = ssoInfo.ssoClient;
                    adminIdToken = ssoInfo.idToken;
                    return ssoClient.cognitoAccountCreate(accountName, adminIdToken, 'Advanced', 0, true);
                }).then(() => {
                    return getWebSocketRunner(adminConfiguration);
                }).then((webSocketRunner) => {
                    adminConfiguration.webSocketRunner = webSocketRunner;
                    const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                    const config = {...adminConfiguration, tokenManager};
                    return uclusion.constructClient(config);
                }).then((client) => {
                    adminAccountClient = client;
                    return adminAccountClient.users.update('Daniel', '{ "code": "red" }');
                }).then((response) => {
                    assert(response.success_message === 'User updated', 'User update was not successful');
                    return adminAccountClient.users.get(adminConfiguration.userId);
                }).then((user) => {
                    assert(user.name === 'Daniel', 'Name not updated properly');
                    assert(user.ui_preferences === '{ "code": "red" }', 'UI preferences not updated properly');
                    return adminAccountClient.users.update('Default');
                }).then((response) => {
                    assert(response.success_message === 'User updated', 'Update not successful');
                    return loginUserToAccount(adminConfiguration);
                }).then((client) => {
                    return client.markets.createMarket(marketOptions);
                }).then((response) => {
                    createdMarketId = response.market_id;
                    return loginUserToMarket(adminConfiguration, createdMarketId);
                }).then((client) => {
                    adminClient = client;
                    return adminClient.markets.updateMarket({locked: true});
                }).then(() => {
                    return loginUserToMarket(userConfiguration, createdMarketId).catch(function(error) {
                        assert(error.status === 401, 'Wrong error = ' + JSON.stringify(error));
                        return 'Market locked';
                    });
                }).then((response) => {
                    assert(response.includes('Market locked'), 'Wrong response = ' + response);
                    return getWebSocketRunner(userConfiguration);
                }).then((webSocketRunner) => {
                    userConfiguration.webSocketRunner = webSocketRunner;
                    // Set active to false to avoid ssoTest error
                    return adminClient.markets.updateMarket({market_stage: 'Inactive'});
                }).catch(function (error) {
                    console.log(error);
                    throw error;
                });
        }).timeout(60000);
    });



};