import assert from 'assert'
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 2,
        new_user_grant: 313
    };
    const planningOptions = {
        name : 'fish planning',
        description: 'this is a fish planning market',
        market_type: 'PLANNING'
    };
    describe('#doCreate and asynchronously expire market', () => {
        it('should create market without error', async() => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let accountClient;
            let createdMarketId;
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.expiration_minutes === marketOptions.expiration_minutes, 'expiration_minutes is incorrect');
                assert(market.account_name, 'Market should have an account name');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                // Have 2 minutes to get here so that can receive the market update for the market expiring
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: createdMarketId});
            }).then(() => {
                return accountClient.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === planningOptions.name, 'Name is incorrect');
                assert(market.description === planningOptions.description, 'Description is incorrect');
                assert(market.account_name, 'Market should have an account name');
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                assert(user.flags.market_admin, 'Should be admin in planning');
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(300000);
    });
};