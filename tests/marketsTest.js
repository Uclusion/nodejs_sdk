import assert from 'assert'
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 3,
        new_user_grant: 313
    };
    const updateOptions = {
        name : 'fish',
        description: 'this is a fish market'
    };
    describe('#doCreate and asynchronously expire market', () => {
        it('should create market without error', async() => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let createdMarketId;
            await promise.then((client) => {
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
                return adminClient.markets.viewed();
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'VIEWED'});
            }).then(() => {
                // Have 3 minutes to get here so that can receive the market update for the market expiring
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: createdMarketId});
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(300000);
    });
};