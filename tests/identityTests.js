import {getSummariesInfo, loginUserToMarket} from '../src/utils';
import { sleep } from './commonTestFunctions';

module.exports = function (adminConfiguration) {

    describe('#cleanup old runs, ', () => {
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
                            deletions.push(sleep(40000));
                        }
                        return Promise.all(deletions).then(() => console.log('Done waiting for cleanup'));
                    });
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};