import assert from 'assert';
import uclusion from 'uclusion_sdk';
import {CognitoAuthorizer} from "uclusion_authorizer_sdk";
import {Auth} from 'aws-amplify';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT} from '../src/TestTokenManager';

module.exports = function (adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration) {
    describe('#doCreate account and update user', () => {
        it('should login and pull without error', async () => {
            let adminAccountClient;
            const date = new Date();
            const timestamp = date.getTime();
            const accountName = 'TestAccount' + timestamp;
            let adminIdToken;
            let adminAccountTokenManager;
            let ssoClient;
            await Auth.signIn(adminConfiguration)
                .then(() => Auth.currentSession())
                .then(cognitoData => cognitoData.idToken.jwtToken)
                .then(jwtToken => {
                    adminIdToken = jwtToken;
                    return uclusion.constructSSOClient(adminConfiguration);
                })
                .then(sso => {
                    ssoClient = sso;
                    return ssoClient.cognitoAccountCreate(accountName, adminIdToken, 'Advanced', true);
                }).then(response => {
                    const accountId = response.account.id;
                    return new TestTokenManager(TOKEN_TYPE_ACCOUNT, accountId, ssoClient);
                }).then((tokenManager) => {
                    const config = {...adminConfiguration, tokenManager};
                    return sleep(30000).then(() => uclusion.constructClient(config));
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
                }).catch(function (error) {
                    console.log(error);
                    throw error;
                });
        }).timeout(60000);
    });
};

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}