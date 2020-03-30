import assert from 'assert'
import {checkStages} from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, getMessages} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market',
        expiration_minutes: 1440,
    };
    const adminExpectedStageNames = [ 'Created', 'In Dialog'];
    describe('#doList', () => {
        it('should list without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let adminId;
            let userId;
            let userExternalId;
            let globalCSMMarketInvestibleId;
            let marketInvestibleId;
            let globalStages;
            let createdMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(butterOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
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
                userExternalId = user.external_id;
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                checkStages(adminExpectedStageNames, stageList);
                return userClient.investibles.create('butter', 'good on bagels');
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                const currentStage = globalStages.find(stage => { return stage.name === 'Created'});
                const nextStage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: currentStage.id,
                    stage_id: nextStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminClient.investibles.create('peanut butter', 'good with jelly');
            }).then((investible) => {
                globalCSMMarketInvestibleId = investible.investible.id;
                return userClient.markets.updateInvestment(marketInvestibleId, 5, 0);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId})
                    .then(() => response);
            }).then((investment) => {
                assert(investment.quantity === 5, 'investment quantity should be 5 instead of ' + investment.quantity);
                return adminClient.users.poke(userId, 'Please add the thing.');
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: userExternalId});
            }).then((payload) => {
                const { hkey, rkey } = payload;
                assert(!hkey && !rkey, 'hkey should not be present');
                return adminClient.markets.listUsers();
            }).then((users) => {
                assert(users.length === 2, '2 users in this dialog');
                const pokedUser = users.find(obj => {
                    return obj.id === userId;
                });
                assert(pokedUser.users_poked.length === 0, 'Should not have poked anyone');
                const { investments } = pokedUser;
                assert(investments.length === 1, `Should have 1 investment instead of ${JSON.stringify(investments)}`);
                const investment = investments[0];
                const { quantity: investmentQuantity, investible_id: investmentInvestibleId } = investment;
                assert(investmentQuantity === 5, 'Should match investment amount above');
                assert(investmentInvestibleId === marketInvestibleId, 'Should match investment ID above');
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
                return userClient.users.removeNotification(adminId, 'USER_POKED', createdMarketId);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: userExternalId});
            }).then((payload) => {
                const { hkey, rkey } = payload;
                assert(hkey, 'hkey should be present');
                assert(rkey === 'USER_POKED_' + adminId, 'rkey should be for poke');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const userPoked = messages.find(obj => {
                    return obj.type_object_id === 'USER_POKED_' + adminId;
                });
                assert(!userPoked, 'Ack failed');
                return userClient.markets.getMarketInvestibles([marketInvestibleId, globalCSMMarketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.investible.id === marketInvestibleId;
                });
                const marketInfo = investible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                const stage = globalStages.find(stage => { return stage.id === marketInfo.stage});
                assert(stage.name === 'In Dialog', 'investible stage should be Created');
                investible = investibles.find(obj => {
                    return obj.investible.id === globalCSMMarketInvestibleId;
                });
                assert(investible, 'Should be able to see other\'s investible in Created');
                return userClient.markets.followMarket(true);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId})
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
