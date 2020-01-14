import assert from 'assert';
import {getSummariesInfo, loginUserToAccount} from '../src/utils';
import _ from 'lodash';

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 20
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
                        assert(marketVersions.length === 1, "Should be associated with a single market after activity");
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
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};
