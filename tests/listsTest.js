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
            let globalCSMInvestibleId;
            let csmMarketInvestibleId;
            let globalInvestibleId;
            let marketInvestibleId;
            let globalStages;
            let createdMarketId;
            let createdMarketInvite;
            await promise.then((client) => {
                const planningOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A',
                    market_sub_type: 'INTEGRATION_TEST'
                };
                return client.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                return client.investibles.createComment(globalInvestibleId, createdMarketId, 'Which kind of butter?', null,
                    'QUESTION', null, null, null, 'DECISION',
                    false, true);
            }).then((response) => {
                createdMarketId = response.market.id;
                globalStages = response.stages;
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
                checkStages(adminExpectedStageNames, globalStages);
                return userClient.investibles.create({groupId: createdMarketId, name: 'butter',
                    description: 'good on bagels'});
            }).then((investible) => {
                globalInvestibleId = investible.investible.id;
                marketInvestibleId = investible.market_infos[0].id;
                const currentStage = globalStages.find(stage => { return stage.name === 'Created'});
                const nextStage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: currentStage.id,
                    stage_id: nextStage.id
                };
                return adminClient.investibles.stateChange(globalInvestibleId, stateOptions);
            }).then(() => {
                return adminClient.investibles.create({groupId: createdMarketId, name: 'peanut butter', description: 'good with jelly'});
            }).then((investible) => {
                globalCSMInvestibleId = investible.investible.id;
                csmMarketInvestibleId = investible.market_infos[0].id;
                return userClient.markets.updateInvestment(globalInvestibleId, 5, 0);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId})
                    .then(() => response);
            }).then((investment) => {
                assert(investment.quantity === 5, 'investment quantity should be 5 instead of ' + investment.quantity);
                return userClient.markets.getMarketInvestibles(
                    [
                        {investible: {id: globalInvestibleId, version: 1},
                            market_infos: [{id: marketInvestibleId, version: 1}]},
                        {investible: {id: globalCSMInvestibleId, version: 1},
                            market_infos: [{id: csmMarketInvestibleId, version: 1}]}
                    ]);
                return userClient.markets.getMarketInvestibles([globalInvestibleId, globalCSMInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.investible.id === globalInvestibleId;
                });
                const marketInfo = investible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                const stage = globalStages.find(stage => { return stage.id === marketInfo.stage});
                assert(stage.name === 'In Dialog', 'investible stage should be Created');
                investible = investibles.find(obj => {
                    return obj.investible.id === globalCSMInvestibleId;
                });
                assert(investible, 'Should be able to see other\'s investible in Created');
                return adminClient.markets.listUsers([{id: userId, version: 1}, {id: adminId, version: 1}]);
            }).then((users) => {
                assert(users.length === 2, '2 users in this dialog');
                return loginUserToAccount(adminConfiguration);
            }).then((client) => {
                return client.users.get();
            }).then((user) => {
                assert(user.notification_configs, 'Notification configs not created');
                assert(user.notification_configs.length > 0, 'Notification configs not created');
                const notification_config = user.notification_configs.find((config) =>
                    config.last_email_at !== undefined);
                // Need test emails sent sooner for this to work
                // assert(notification_config, 'last_email_at not updating');
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
