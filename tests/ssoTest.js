import assert from 'assert';
import {CognitoAuthorizer} from 'uclusion_authorizer_sdk';
import uclusion from 'uclusion_sdk';

module.exports = function(adminConfiguration, adminAuthorizerConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 2,
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
                assert(login_info.ui_url, 'Markets should have a ui_url');
                assert(login_info.allow_cognito, 'Cognito should be allowed on this test market');
                assert(login_info.allow_user === false, 'User logins should not be supported on this market');
                assert(login_info.user_pool_id === adminAuthorizerConfiguration.poolId, 'Cognito pool should match the authorizer pool');
                assert(login_info.cognito_client_id === adminAuthorizerConfiguration.clientId, 'Cognito client id should match the authorizer client id');
                return globalClient.markets.deleteMarket();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};
