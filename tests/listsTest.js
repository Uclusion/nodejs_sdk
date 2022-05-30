import assert from 'assert'
import {checkStages} from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, loginUserToMarketInvite} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
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
            let createdMarketInvite;
            await promise.then((client) => {
                const planningOptions = {
                    market_type: 'PLANNING',
                    market_sub_type: 'TEST'
                };
                return client.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                return client.investibles.createComment(marketInvestibleId, 'Which kind of butter?', null,
                    'QUESTION', null, null, null, 'DECISION',
                    false, true);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
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
                return userClient.investibles.create({name: 'butter', description: 'good on bagels'});
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
                return adminClient.investibles.create({name: 'peanut butter', description: 'good with jelly'});
            }).then((investible) => {
                globalCSMMarketInvestibleId = investible.investible.id;
                return userClient.markets.updateInvestment(marketInvestibleId, 5, 0);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId})
                    .then(() => response);
            }).then((investment) => {
                assert(investment.quantity === 5, 'investment quantity should be 5 instead of ' + investment.quantity);
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
                return adminClient.markets.listUsers();
            }).then((users) => {
                assert(users.length === 2, '2 users in this dialog');
                adminConfiguration.webSocketRunner.terminate();
                return userConfiguration.webSocketRunner.terminate();
            }).catch(function(error) {
                adminConfiguration.webSocketRunner.terminate();
                userConfiguration.webSocketRunner.terminate();
                console.log(error);
                throw error;
            });
        }).timeout(180000);
    });
};
