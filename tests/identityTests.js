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
                        const marketVersions = versions.filter((versionRow) => versionRow.type_object_id.includes('market'));
                        const deletions = marketVersions.map((versionRow) => {
                            const {type_object_id} = versionRow;
                            const marketId = type_object_id.split('_')[1];
                            console.log('Found ' + marketId);
                            return loginUserToMarket(adminConfiguration, marketId)
                                .then(client => client.markets.deleteMarket());
                        });
                        if (deletions) {
                            deletions.push(sleep(30000));
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