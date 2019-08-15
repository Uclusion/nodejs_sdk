import assert from 'assert'
import {WebSocketRunner} from "../src/WebSocketRunner";
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 30,
        new_user_grant: 313
    };
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000});
    webSocketRunner.connect();
    describe('#do market investible tests', () => {
        it('create investible and deletion without error', async() => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let accountClient;
            let createdMarketId;
            let clonedMarketId;
            let marketInvestibleId;
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                webSocketRunner.subscribe(user.id, { market_id : createdMarketId });
                return adminClient.investibles.create('salmon', 'good on bagels');
            }).then((investible) => {
                marketInvestibleId = investible.id;
                return adminClient.markets.updateMarket({active: false});
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.create('salmon', 'good on bagels')
                    .catch(function(error) {
                        assert(error.status === 403, 'Wrong error = ' + JSON.stringify(error));
                        return 'Market inactive';
                    });
            }).then((response) => {
                assert(response.includes('Market inactive'), 'Wrong response = ' + response);
                return accountClient.markets.createMarket(marketOptions);
            }).then((response) => {
                clonedMarketId = response.market_id;
                return adminClient.investibles.copy(marketInvestibleId, clonedMarketId);
            }).then((investibleId) => {
                marketInvestibleId = investibleId;
                return adminClient.markets.deleteMarket();
            }).then(() => {
                return loginUserToMarket(adminConfiguration, clonedMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                webSocketRunner.subscribe(user.id, { market_id : clonedMarketId });
                return adminClient.investibles.delete(marketInvestibleId);
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_DELETED', object_id: marketInvestibleId});
            }).then((response) => {
                return adminClient.markets.deleteMarket();
            }).then(() => {
                webSocketRunner.terminate();
            }).catch(function(error) {
                console.log(error);
                //close our websocket
                webSocketRunner.terminate();
                throw error;
            });
        }).timeout(240000);
    });
};