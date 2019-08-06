import assert from 'assert';
import {getSSOInfo, loginUserToAccount, loginUserToMarket} from '../src/utils';
import _ from 'lodash';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_MARKET} from '../src/TestTokenManager';

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 20,
        new_user_grant: 313
    };
    describe('#do account sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let promise = loginUserToAccount(adminConfiguration, adminConfiguration.accountId);
            let adminClient;
            let globalMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, globalMarketId);
            }).then((client) => {
                adminClient = client;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, globalMarketId);
                return uclusion.constructSSOClient(adminConfiguration, tokenManager).then(client => client.marketLoginInfo(globalMarketId));
            }).then((login_info) => {
                console.log(login_info);
                assert(login_info.active === true, 'Market should be active for 20m');
                assert(login_info.name === marketOptions.name, 'Market name should be correct');
                assert(login_info.description === marketOptions.description, 'Market description should be correct');
                return adminClient.markets.deleteMarket();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
    describe('#do identity sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let authPromise = getSSOInfo(adminConfiguration);
            let createdMarketId;
            await authPromise.then((ssoInfo) => {
                const { ssoClient, idToken } = ssoInfo;
                return ssoClient.availableMarkets(idToken, true)
                    .then((result) => {
                        assert(_.isEmpty(result), "Shouldn't be associated with any market");
                        return result;
                    }).then(() => {
                        return loginUserToAccount(adminConfiguration, adminConfiguration.accountId);
                    }).then(client => client.markets.createMarket((marketOptions)))
                    .then((response) => {
                        createdMarketId = response.marketId;
                        return ssoClient.availableMarkets(idToken, true);
                    }).then((result) => {
                        assert(!_.isEmpty(result), "Should have one market associated");
                        return result;
                    })

            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};
