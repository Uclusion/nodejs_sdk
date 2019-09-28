import assert from 'assert'
import { checkStages } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, getMessages} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market',
        expiration_minutes: 10,
    };
    const adminExpectedStageNames = [ 'Created', 'In Moderation', 'In Dialog'];
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
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                checkStages(adminExpectedStageNames, stageList);
                return userClient.investibles.create('butter', 'good on bagels');
            }).then((investibleId) => {
                marketInvestibleId = investibleId;
                return adminClient.investibles.create('peanut butter', 'good with jelly');
            }).then((investibleId) => {
                globalCSMMarketInvestibleId = investibleId;
                return adminClient.users.grant(userId, 10000);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED'})
                    .then(() => response);
            }).then(() => {
                return userClient.markets.updateInvestment(marketInvestibleId, 6001, 0);
            }).then((investment) => {
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                return adminClient.users.poke(userId, 'Please add the thing.');
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_MESSAGES_UPDATED'})
                    .then(() => response);
            }).then(() => {
                return adminClient.markets.listUsers();
            }).then((users) => {
                assert(users.length === 2, '2 users in this dialog');
                const pokedUser = users.find(obj => {
                    return obj.id === userId;
                });
                assert(pokedUser.users_poked.length === 0, 'Should not have poked anyone');
                const userPoking = users.find(obj => {
                    return obj.id !== userId;
                });
                assert(userPoking.users_poked.length === 1, 'Should have poked someone');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const userPoked = messages.find(obj => {
                    return obj.type_object_id === 'USER_POKED_' + adminId;
                });
                assert(userPoked.text === 'Please add the thing.', 'Wrong poke text');
                return userClient.markets.viewed();
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_MESSAGES_UPDATED'});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const userPoked = messages.find(obj => {
                    return obj.type_object_id === 'USER_POKED_' + adminId;
                });
                assert(!userPoked, 'Ack failed');
                return userClient.markets.listInvestibles();
            }).then((result) => {
                const investibles = result.investibles;
                const investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.id === marketInvestibleId, 'should find the investible');
                return userClient.markets.getMarketInvestibles([marketInvestibleId, globalCSMMarketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.investible.id === marketInvestibleId;
                });
                const marketInfo = investible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                const stage = globalStages.find(stage => { return stage.id === marketInfo.stage});
                assert(stage.name === 'Created', 'investible stage should be Created');
                investible = investibles.find(obj => {
                    return obj.investible.id === globalCSMMarketInvestibleId;
                });
                assert(!investible, 'Should not be able to see other\'s investible in Created');
                return userClient.markets.followMarket(true);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED'})
                    .then(() => response);
            }).then(() => {
                return adminClient.markets.listUsers();
            }).then((users) => {
                const activeUsers = users.filter(user => user.following);
                assert(users.length === 2, '2 users in this dialog');
                assert(activeUsers.length === 1, '1 user following in this dialog');
                adminConfiguration.webSocketRunner.terminate();
                return userConfiguration.webSocketRunner.terminate();
            }).catch(function(error) {
                adminConfiguration.webSocketRunner.terminate();
                userConfiguration.webSocketRunner.terminate();
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};
