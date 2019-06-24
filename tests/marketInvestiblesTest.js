import assert from 'assert'
import {uclusion} from "../src/uclusion";
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
    const expectedWebsocketMessages = [];
    describe('#do market investible tests', () => {
        it('create investible binding and deletion without error', async() => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let investibleTemplateId;
            let globalMarketId;
            let marketInvestibleId;
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
                webSocketRunner.connect();
                webSocketRunner.subscribe(adminConfiguration.userId, { market_id : globalMarketId });
                return globalClient.investibles.create('salmon', 'good on bagels');
            }).then((investible) => {
                investibleTemplateId = investible.id;
                return globalClient.investibles.createCategory('foo');
            }).then((category) => {
                return globalClient.markets.updateMarket({active: false});
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: globalMarketId});
            }).then((category) => {
                return globalClient.investibles.bindToMarket(investibleTemplateId, ['foo']);
            }).then((response) => {
                const responseJson = JSON.stringify(response);
                assert(responseJson.includes('Market inactive'), 'Wrong response = ' + responseJson);
                return globalClient.markets.updateMarket({active: true});
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: globalMarketId});
            }).then(() => {
                return globalClient.investibles.bindToMarket(investibleTemplateId, ['foo']);
            }).then((bound) => {
                marketInvestibleId = bound.id;
                return globalClient.investibles.delete(marketInvestibleId);
            }).then(() => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_DELETED', object_id: marketInvestibleId});
            }).then(() => {
                return globalClient.investibles.delete(investibleTemplateId);
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
        }).timeout(90000);
    });
};