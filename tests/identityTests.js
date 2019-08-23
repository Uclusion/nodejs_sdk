import {getSSOInfo, loginUserWithToken} from '../src/utils';
import { sleep } from './commonTestFunctions';

module.exports = function (adminConfiguration) {

    describe('#cleanup old runs, ', () => {
        it('should cleanup old markets for the identity', async () => {
            const promise = getSSOInfo(adminConfiguration);
            await promise.then((ssoInfo) => {
                const {ssoClient, idToken} = ssoInfo;
                return ssoClient.availableMarkets(idToken)
                    .then((markets) => {
                        const deletions = markets.map((market) => {
                            if (market.active) {
                                console.log('Found ' + market.id);
                                return loginUserWithToken(adminConfiguration, market.uclusion_token, market.id)
                                    .then(client => client.markets.deleteMarket());
                            }
                        });
                        if (deletions) {
                            deletions.push(sleep(20000));
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