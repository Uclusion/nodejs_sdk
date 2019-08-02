import assert from 'assert';
import {CognitoAuthorizer} from 'uclusion_authorizer_sdk';
import uclusion from 'uclusion_sdk';

module.exports = function(adminConfiguration, adminAuthorizerConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 20,
        new_user_grant: 313
    };
    describe('#do sso tests, ', () => {
        it('should retrieve login info without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                const configuration = {...adminConfiguration};
                const adminAuthorizerConfig = {...adminAuthorizerConfiguration};
                adminAuthorizerConfig.marketId = response.market_id;
                configuration.authorizer = new CognitoAuthorizer(adminAuthorizerConfig);
                globalMarketId = response.market_id;
                return uclusion.constructClient(configuration);
            }).then((client) => {
                globalClient = client;
                return uclusion.constructSSOClient(adminConfiguration).then(client => client.marketLoginInfo(globalMarketId));
            }).then((login_info) => {
                console.log(login_info);
                assert(login_info.active === true, 'Market should be active for 20m');
                assert(login_info.name === marketOptions.name, 'Market name should be correct');
                assert(login_info.description === marketOptions.description, 'Market description should be correct');
                return globalClient.markets.deleteMarket();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};
