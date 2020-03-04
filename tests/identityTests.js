import {getSummariesInfo, loginUserToMarket} from '../src/utils';
import { sleep } from './commonTestFunctions';

const DELETION_TIMEOUT = 60000; // wait 60 seconds to delete a market
module.exports = function (adminConfiguration) {

    describe('#cleanup old runs, ', () => {
      let timeout;
        it('should cleanup old markets for the identity', async () => {
            const promise = getSummariesInfo(adminConfiguration);
            await promise.then((summariesInfo) => {
                const {summariesClient, idToken} = summariesInfo;
                return summariesClient.versions(idToken)
                    .then((versions) => {
                        const { signatures } = versions;
                        const deletions = signatures.map((signature) => {
                            const {market_id: marketId} = signature;
                            console.log('Found ' + marketId);
                            return loginUserToMarket(adminConfiguration, marketId)
                                .then(client => client.markets.deleteMarket());
                        });
                        if (deletions) {
                            deletions.push(sleep(DELETION_TIMEOUT));
                        }
                        timeout = DELETION_TIMEOUT + (DELETION_TIMEOUT * deletions.length);
                        return Promise.all(deletions).then(() => console.log('Done waiting for cleanup'));
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