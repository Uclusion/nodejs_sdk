import {getSSOInfo, loginUserToMarket} from '../src/utils';
import { sleep } from './commonTestFunctions';

module.exports = function (adminConfiguration) {

    describe('#cleanup old runs, ', () => {
        it('should cleanup old markets for the identity', async () => {
            const promise = getSSOInfo(adminConfiguration);
            await promise.then((ssoInfo) => {
                const {ssoClient, idToken} = ssoInfo;
                return ssoClient.availableMarkets(idToken, true)
                    .then((markets) => {
                        const deletions = markets.map((market) => {
                            console.log('Found ' + market.id);
                            return loginUserToMarket(adminConfiguration, market.id)
                                .then(client => client.markets.deleteMarket());
                        });
                        deletions.push(sleep(20000));
                        return Promise.all(deletions).then(() => console.log('Done waiting for cleanup'));
                    });
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};