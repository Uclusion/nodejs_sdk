import assert from 'assert';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT} from '../src/TestTokenManager';
import { sleep } from './commonTestFunctions';
import {getSSOInfo, loginUserToAccount, loginUserToMarket} from '../src/utils';

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
            const accountName = 'TestAccount' + timestamp;
            let adminIdToken;
            let ssoClient;
            await getSSOInfo(adminConfiguration).then(ssoInfo => {
                    ssoClient = ssoInfo.ssoClient;
                    adminIdToken = ssoInfo.idToken;
                    return ssoClient.cognitoAccountCreate(accountName, adminIdToken, 'Advanced', true);
                }).then(response => {
                    return new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
                }).then((tokenManager) => {
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
                }).catch(function (error) {
                    console.log(error);
                    throw error;
                });
        }).timeout(60000);
    });



};