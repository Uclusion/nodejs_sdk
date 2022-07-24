import assert from 'assert';
import {getSummariesInfo, loginUserToAccount} from '../src/utils';
import _ from 'lodash';

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name: 'Company A',
        market_type: 'PLANNING'
    };

    describe('#do identity sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let authPromise = getSummariesInfo(adminConfiguration);
            let createdMarketId;
            await authPromise.then((summariesInfo) => {
                const {summariesClient, idToken} = summariesInfo;
                return summariesClient.idList(idToken).then((audits) => {
                    const allMarkets = audits.map((audit) => audit.id);
                    return summariesClient.versions(idToken, allMarkets);
                }).then((versions) => {
                        const { signatures } = versions;
                        console.log(signatures);
                        assert(signatures.length === 1, "Should be associated with a single market after activity");
                        return signatures;
                    }).then(() => {
                        return loginUserToAccount(adminConfiguration);
                    }).then(client => client.markets.createMarket(marketOptions))
                    .then((response) => {
                        createdMarketId = response.market.id;
                        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
                    })
                    .then(() => {
                        return summariesClient.idList(idToken).then((audits) => {
                            const allMarkets = audits.map((audit) => audit.id);
                            return summariesClient.versions(idToken, allMarkets);
                        });
                    }).then((versions) => {
                        const { signatures } = versions;
                        assert(!_.isEmpty(signatures), "Should have one market associated");
                        return signatures[0].market_id;
                    })
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};
