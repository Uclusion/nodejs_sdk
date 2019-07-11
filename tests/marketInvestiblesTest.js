import assert from 'assert'
import uclusion from 'uclusion_sdk';
import {WebSocketRunner} from "../src/websocketRunner";
import {CognitoAuthorizer} from "uclusion_authorizer_sdk";

module.exports = function(adminConfiguration, adminAuthorizerConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        trending_window: 2,
        new_user_grant: 313,
        new_team_grant: 457
    };
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000});
    webSocketRunner.connect();
    describe('#do market investible tests', () => {
        it('create investible and deletion without error', async() => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalMarketId;
            let marketInvestibleId;
            await promise.then((client) => {
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                webSocketRunner.subscribe(adminConfiguration.userId, { market_id : globalMarketId });
                const configuration = {...adminConfiguration};
                const adminAuthorizerConfig = {...adminAuthorizerConfiguration};
                adminAuthorizerConfig.marketId = response.market_id;
                configuration.authorizer = new CognitoAuthorizer(adminAuthorizerConfig);
                return uclusion.constructClient(configuration);
            }).then((client) => {
                globalClient = client;
                return globalClient.investibles.create('salmon', 'good on bagels');
            }).then((investible) => {
                marketInvestibleId = investible.id;
                return globalClient.markets.updateMarket({active: false});
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: globalMarketId});
            }).then((category) => {
                return globalClient.investibles.delete(marketInvestibleId)
                    .catch(function(error) {
                        assert(error.status === 403, 'Wrong error = ' + JSON.stringify(error));
                        return 'Market inactive';
                    });
            }).then((response) => {
                assert(response.includes('Market inactive'), 'Wrong response = ' + response);
                return globalClient.markets.updateMarket({active: true});
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: globalMarketId});
            }).then(() => {
                return globalClient.investibles.delete(marketInvestibleId);
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_DELETED', object_id: marketInvestibleId}, 9000);
            }).then(() => {
                return globalClient.markets.deleteMarket();
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