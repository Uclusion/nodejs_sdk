import assert from 'assert'
import {WebSocketRunner} from "../src/WebSocketRunner";
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 2,
        new_user_grant: 313
    };
    const updateOptions = {
        name : 'fish',
        description: 'this is a fish market'
    };
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000});
    webSocketRunner.connect();
    describe('#doCreate, update, grant and follow market', () => {
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
                return adminClient.users.get();
            }).then((user) => {
                // Have 2 minutes to get here so that can receive the market update for the market expiring
                webSocketRunner.subscribe(user.id, {market_id: createdMarketId});
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.active === false, 'Market should have expired while waiting above');
                assert(market.expiration_minutes === marketOptions.expiration_minutes, 'expiration_minutes is incorrect');
                assert(market.account_name, 'Market should have an account name');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                webSocketRunner.terminate();
                return adminClient.markets.deleteMarket();
            }).catch(function(error) {
                webSocketRunner.terminate();
                console.log(error);
                throw error;
            });
        }).timeout(300000);
    });
};