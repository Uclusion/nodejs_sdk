import assert from 'assert';
import {getSSOInfo, loginUserToAccount, loginUserToMarket, loginUserWithToken} from '../src/utils';
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

    describe('#do identity sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let authPromise = getSSOInfo(adminConfiguration);
            let createdMarketId;
            let adminClient;
            await authPromise.then((ssoInfo) => {
                const { ssoClient, idToken } = ssoInfo;
                return ssoClient.availableMarkets(idToken)
                    .then((result) => {
                        const activeMarkets = result.filter(market => market.stage === 'Active');
                        console.log(activeMarkets);
                        assert(_.isEmpty(activeMarkets), "Associated with a market");
                        return activeMarkets;
                    }).then(() => {
                        return loginUserToAccount(adminConfiguration);
                    }).then(client => client.markets.createMarket(marketOptions))
                    .then((response) => {
                        createdMarketId = response.market_id;
                        return ssoClient.availableMarkets(idToken);
                    }).then((result) => {
                        const activeMarkets = result.filter(market => market.stage === 'Active');
                        assert(!_.isEmpty(activeMarkets), "Should have one market associated");
                        return activeMarkets[0];
                    })
            }).then((market) => {
                return loginUserWithToken(adminConfiguration, market.uclusion_token, market.id);
            }).then((client) => {
                adminClient = client;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, createdMarketId);
                return uclusion.constructSSOClient(adminConfiguration, tokenManager).then(client => client.marketLoginInfo(createdMarketId));
            }).then((login_info) => {
                console.log(login_info);
                assert(login_info.stage === 'Active', 'Market should be active for 20m');
                assert(login_info.name === marketOptions.name, 'Market name should be correct');
                assert(login_info.description === marketOptions.description, 'Market description should be correct');
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
};
