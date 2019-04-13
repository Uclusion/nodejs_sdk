import assert from 'assert'
import {uclusion} from "../src/uclusion";
import {verifyExpectedMessages, sleep} from "./commonTestFunctions";
import {WebSocketRunner} from "../src/websocketRunner";

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        trending_window: 2,
        manual_roi: false,
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
            let globalStageId;
            let marketInvestibleId;
            await promise.then((client) => {
                globalClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                webSocketRunner.connect();
                webSocketRunner.subscribe(adminConfiguration.userId, { market_id : globalMarketId });
                return globalClient.investibles.create('salmon', 'good on bagels');
            }).then((investible) => {
                investibleTemplateId = investible.id;
                return globalClient.investibles.createCategory('foo', globalMarketId);
            }).then((category) => {
                return globalClient.investibles.bindToMarket(investibleTemplateId, globalMarketId, ['foo']);
            }).then((bound) => {
                marketInvestibleId = bound.id;
                return globalClient.investibles.delete(marketInvestibleId);
            }).then(() => {
                expectedWebsocketMessages.push({event_type: 'MARKET_INVESTIBLE_DELETED', object_id: marketInvestibleId});
                return globalClient.investibles.delete(investibleTemplateId);
            }).then((bound) => {
                return sleep(10000);
            }).then(() => {
                return globalClient.markets.deleteMarket(globalMarketId);
            }).then(() => {
                const messages = webSocketRunner.getMessagesReceived();
                verifyExpectedMessages(messages, expectedWebsocketMessages);
                //close our websocket
                webSocketRunner.terminate();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};