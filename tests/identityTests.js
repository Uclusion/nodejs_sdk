import {getSummariesInfo, loginUserToAccount, loginUserToMarket} from '../src/utils';
import { sleep } from './commonTestFunctions';
import _ from 'lodash';

const DELETION_TIMEOUT = 60000; // wait 60 seconds to delete a market
module.exports = function (adminConfiguration) {

    describe('#cleanup old runs, ', () => {
      let timeout;
        it('should cleanup old markets for the identity', async () => {
            const promise = getSummariesInfo(adminConfiguration);
            await promise.then((summariesInfo) => {
                const {summariesClient, idToken} = summariesInfo;
                return summariesClient.idList(idToken).then((result) => {
                    const { foreground, background } = result;
                    const all_markets = (foreground || []).concat(background || []);
                    if (all_markets.length === 0) {
                        return {signatures: []};
                    }
                    const chunks = _.chunk(all_markets, 24);
                    const versionPromises = chunks.map((chunk) => {
                        return summariesClient.versions(idToken, chunk).then((versions) => {
                            const { signatures } = versions;
                            const deletions = signatures.map((signature) => {
                                const {market_id: marketId} = signature;
                                let globalClient;
                                return loginUserToMarket(adminConfiguration, marketId)
                                    .then((client) => {
                                        globalClient = client;
                                        return client.markets.get();
                                    }).then((market) => {
                                        const { created_by: createdBy, current_user_id: currentUserId } = market;
                                        if (createdBy === currentUserId) {
                                            console.log(`For ${currentUserId} and ${createdBy} deleting ${JSON.stringify(market)}`);
                                            return globalClient.markets.deleteMarket();
                                        } else {
                                            console.log(`Unable to delete ${JSON.stringify(market)}`);
                                        }
                                    });
                            });
                            if (deletions) {
                                deletions.push(sleep(DELETION_TIMEOUT));
                            }
                            timeout = DELETION_TIMEOUT + (DELETION_TIMEOUT * deletions.length);
                            return Promise.all(deletions);
                        });
                    });
                    return Promise.all(versionPromises)
                        .then(() => loginUserToAccount(adminConfiguration))
                        .then((client) => client.users.cleanAccount())
                        .then(() => console.log('Done waiting for cleanup'));
                });
            }).catch(function (error) {
                const { status } = error;
                if (status !== 404) {
                    console.log(error);
                    throw error;
                }
            });
        }).timeout(timeout);
    });
};