import {loginUserToAccount, loginUserToAccountAndGetToken, loginUserToIdentity, loginUserToMarket} from '../src/utils';
import { sleep } from './commonTestFunctions';
import _ from 'lodash';

const DELETION_TIMEOUT = 60000; // wait 60 seconds to delete a market
module.exports = function (adminConfiguration) {

    // Avoid parallel logins into Cognito
    const resolvePromisesSeq = async (tasks) => {
        const results = [];
        for (const task of tasks) {
            results.push(await task);
        }

        return results;
    };

    describe('#login and cleanup old runs, ', () => {
      let timeout;
        it('should cleanup old markets for the identity', async () => {
            // idToken lasts an hour so use it instead of trying to switch by signing in again
            const promise = loginUserToIdentity(adminConfiguration)
                .then((jwtToken) => {
                    adminConfiguration.idToken = jwtToken;
                    return loginUserToAccountAndGetToken(adminConfiguration);
                });
            await promise.then((response) => {
                const { client, accountToken } = response;
                return client.summaries.idList(accountToken).then((audits) => {
                    if (_.isEmpty(audits)) {
                        return {signatures: []};
                    }
                    const allMarkets = audits.map((audit) => audit.id);
                    console.log(`Processing ${allMarkets}`);
                    const chunks = _.chunk(allMarkets, 24);
                    const versionPromises = chunks.map((chunk) => {
                        return client.summaries.versions(accountToken, chunk).then((versions) => {
                            const { signatures } = versions;
                            const deletions = signatures.map((signature) => {
                                const {market_id: marketId} = signature;
                                let globalClient;
                                console.log(`Now on ${marketId}`)
                                return loginUserToMarket(adminConfiguration, marketId)
                                    .then((client) => {
                                        globalClient = client;
                                        return client.markets.get();
                                    }).then((market) => {
                                        const { created_by: createdBy, current_user_id: currentUserId } = market;
                                        console.log(`For ${currentUserId} and ${createdBy} deleting ${JSON.stringify(market)}`);
                                        return globalClient.markets.deleteMarket();
                                    });
                            });
                            if (deletions) {
                                deletions.push(sleep(DELETION_TIMEOUT));
                            }
                            timeout = DELETION_TIMEOUT + (DELETION_TIMEOUT * deletions.length);
                            return resolvePromisesSeq(deletions);
                        });
                    });
                    return resolvePromisesSeq(versionPromises);
                }).then(() => loginUserToAccount(adminConfiguration))
                    .then((client) => client.users.cleanAccount())
                    .then(() => console.log('Done with cleanup'));
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