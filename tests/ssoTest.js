import assert from 'assert';
import { loginUserToAccount, loginUserToMarket } from '../src/utils';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_MARKET} from "../src/TestTokenManager";

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 20,
        new_user_grant: 313
    };
    describe('#do sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let promise = loginUserToAccount(adminConfiguration, adminConfiguration.accountId);
            let adminClient;
            let globalMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, globalMarketId);
            }).then((client) => {
                adminClient = client;
                const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, globalMarketId);
                return uclusion.constructSSOClient(adminConfiguration, tokenManager).then(client => client.marketLoginInfo(globalMarketId));
            }).then((login_info) => {
                console.log(login_info);
                assert(login_info.active === true, 'Market should be active for 20m');
                assert(login_info.name === marketOptions.name, 'Market name should be correct');
                assert(login_info.description === marketOptions.description, 'Market description should be correct');
                return adminClient.markets.deleteMarket();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};
