import {getSSOInfo, loginUserToAccount, loginUserToMarket} from '../src/utils';
import {Auth} from 'aws-amplify';
import uclusion from 'uclusion_sdk';
import { sleep } from './commonTestFunctions';

module.exports = function (adminConfiguration) {

    describe('#cleanup old runs, ', () => {
        it('should cleanup old markets for the identity', async () => {
            const promise = getSSOInfo(adminConfiguration);
            await promise.then((ssoInfo) => {
                const {ssoClient, idToken} = ssoInfo;
                return ssoClient.availableMarkets(idToken, true)
                    .then((markets) => {
                        const deletions = Object.keys(markets).map((marketId) => {
                            return loginUserToMarket(adminConfiguration, marketId)
                                .then(client => client.markets.deleteMarket());
                        });
                        return Promise.all(deletions).then(() => sleep(20000));
                    });
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};