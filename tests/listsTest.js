import assert from 'assert'
import { checkStages } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket} from "../src/utils";
import {WebSocketRunner} from "../src/WebSocketRunner";

module.exports = function(adminConfiguration, userConfiguration) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market',
        expiration_minutes: 10,
    };
    const adminExpectedStageNames = [ 'Created', 'In Moderation', 'In Dialog'];
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000});
    describe('#doList', () => {
        it('should list without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let adminId;
            let userId;
            let globalCSMMarketInvestibleId;
            let marketInvestibleId;
            let globalStages;
            let createdMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(butterOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                webSocketRunner.connect();
                webSocketRunner.subscribe(user.id, { market_id : createdMarketId });
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                checkStages(adminExpectedStageNames, stageList);
                return userClient.investibles.create('butter', 'good on bagels');
            }).then((response) => {
                marketInvestibleId = response.id;
                return adminClient.investibles.create('peanut butter', 'good with jelly');
            }).then((investible) => {
                globalCSMMarketInvestibleId = investible.id;
                assert(investible.name === 'peanut butter', 'name not passed on correctly');
                assert(investible.quantity === 0, 'market investible quantity incorrect');
                return adminClient.users.grant(userId, 10000);
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED'})
                    .then(() => response);
            }).then(() => {
                return userClient.markets.updateInvestment(marketInvestibleId, 6001, 0);
            }).then((investment) => {
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                return adminClient.users.poke(userId, 'Please add the thing.');
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'USER_MESSAGES_UPDATED'})
                    .then(() => response);
            }).then(() => {
                return adminClient.markets.listUsers();
            }).then((users) => {
                assert(users.length === 2, '2 users in this dialog');
                const pokedUser = users.find(obj => {
                    return obj.id === userId;
                });
                assert(pokedUser.users_poked.length === 0, 'Should not have poked anyone');
                assert(pokedUser.quantity === 4099, 'Quantity wrong is ' + pokedUser.quantity);
                assert(pokedUser.quantity_invested === 6001, 'Quantity invested wrong is ' + pokedUser.quantity_invested);
                const userPoking = users.find(obj => {
                    return obj.id !== userId;
                });
                assert(userPoking.users_poked.length === 1, 'Should have poked someone');
                return userClient.users.getMessages();
            }).then((messages) => {
                const userPoked = messages.find(obj => {
                    return obj.type_object_id === 'USER_POKED_' + adminId;
                });
                assert(userPoked.text === 'Please add the thing.', 'Wrong poke text');
                return userClient.users.acknowledge(adminId, 'USER_POKED');
            }).then(() => {
                return userClient.users.getMessages();
            }).then((messages) => {
                const userPoked = messages.find(obj => {
                    return obj.type_object_id === 'USER_POKED_' + adminId;
                });
                assert(!userPoked, 'Ack failed');
                return userClient.markets.listInvestibles();
            }).then((result) => {
                let investibles = result.investibles;
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.id === marketInvestibleId, 'should find the investible');
                return userClient.markets.getMarketInvestibles([marketInvestibleId, globalCSMMarketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                let stage = globalStages.find(stage => { return stage.id === investible.stage});
                assert(stage.name === 'Created', 'investible stage should be Created');
                investible = investibles.find(obj => {
                    return obj.id === globalCSMMarketInvestibleId;
                });
                assert(!investible, 'Should not be able to see other\'s investible in Created');
                return userClient.markets.followMarket(true);
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED'})
                    .then(() => response);
            }).then(() => {
                return adminClient.markets.listUsers();
            }).then((users) => {
                assert(users.length === 1, '1 user remaining in this dialog');
                webSocketRunner.terminate();
                return adminClient.markets.deleteMarket();
            }).catch(function(error) {
                webSocketRunner.terminate();
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};
