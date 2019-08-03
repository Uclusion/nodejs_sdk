import assert from 'assert'
import uclusion from 'uclusion_sdk';
import {WebSocketRunner} from "../src/WebSocketRunner";
import {CognitoAuthorizer} from "uclusion_authorizer_sdk";
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
            let promise = loginUserToAccount(adminConfiguration, adminConfiguration.accountId);
            let adminClient;
            let createdMarketId;
            let marketInvestibleId;
            await promise.then((client) => {
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
                return adminClient.investibles.delete(investible.id);
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_DELETED', object_id: marketInvestibleId});
            }).then((investible) => {
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