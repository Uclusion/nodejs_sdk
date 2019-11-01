import assert from 'assert';
import {getSummariesInfo, loginUserToAccount, loginUserToMarket} from '../src/utils';
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
            let authPromise = getSummariesInfo(adminConfiguration);
            let createdMarketId;
            let adminClient;
            await authPromise.then((summariesInfo) => {
                const {summariesClient, idToken} = summariesInfo;
                return summariesClient.versions(idToken)
                    .then((versions) => {
                        const marketVersions = versions.filter((versionRow) => versionRow.type_object_id.includes('market'));
                        console.log(marketVersions);
                        assert(_.isEmpty(marketVersions), "Associated with a market");
                        return marketVersions;
                    }).then(() => {
                        return loginUserToAccount(adminConfiguration);
                    }).then(client => client.markets.createMarket(marketOptions))
                    .then((response) => {
                        createdMarketId = response.market_id;
                        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
                    })
                    .then((response) => {
                        assert(response.version === 1, "Should be first version instead of " + response.version);
                        return summariesClient.versions(idToken);
                    }).then((versions) => {
                        const marketVersions = versions.filter((versionRow) => versionRow.type_object_id.includes('market'));
                        assert(!_.isEmpty(marketVersions), "Should have one market associated");
                        return marketVersions[0].type_object_id.split('_')[1];
                    })
            }).then((marketId) => {
                return loginUserToMarket(adminConfiguration, marketId);
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
        }).timeout(120000);
    });
};
