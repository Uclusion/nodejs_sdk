import assert from 'assert'
import {getMessages, loginUserToAccount, loginUserToMarket} from "../src/utils";
import {arrayEquals, checkStages} from "./commonTestFunctions";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 2,
        new_user_grant: 313
    };
    const planningOptions = {
        name : 'fish planning',
        description: 'this is a fish planning market',
        market_type: 'PLANNING'
    };
    const initiativeOptions = {
        name : 'fish initiative',
        description: 'this is a fish initiative',
        market_type: 'INITIATIVE'
    };
    const plannedStageNames = ['In Dialog', 'Accepted', 'Archived'];
    const initiativeStageNames = ['In Dialog'];
    describe('#doCreate and asynchronously expire market', () => {
        it('should create market without error', async() => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let accountClient;
            let createdMarketId;
            let userId;
            let userExternalId;
            let adminId;
            let marketInvestibleId;
            let globalStages;
            let acceptedStage;
            let currentStage;
            let inDialogStage;
            let stateOptions;
            let investible;
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.expiration_minutes === marketOptions.expiration_minutes, 'expiration_minutes is incorrect');
                assert(market.account_name, 'Market should have an account name');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                // Have 2 minutes to get here so that can receive the market update for the market expiring
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
            }).then(() => {
                return accountClient.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === planningOptions.name, 'Name is incorrect');
                assert(market.description === planningOptions.description, 'Description is incorrect');
                assert(market.account_name, 'Market should have an account name');
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                assert(user.flags.market_admin, 'Should be admin in planning');
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                checkStages(plannedStageNames, stageList);
                return userClient.investibles.create('salmon spawning', 'plan to catch', null, [userId]);
            }).then((investibleId) => {
                marketInvestibleId = investibleId;
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                investible = fullInvestible.investible;
                const marketInfo = fullInvestible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                assert(arrayEquals(marketInfo.assigned, [userId]), 'assigned should be correct');
                inDialogStage = globalStages.find(stage => { return stage.appears_in_market_summary });
                assert(marketInfo.stage === inDialogStage.id, 'Instead of ' + marketInfo.stage + ' which is ' + marketInfo.stage_name);
                acceptedStage = globalStages.find(stage => { return stage.name === 'Accepted'});
                stateOptions = {
                    current_stage_id: inDialogStage.id,
                    stage_id: acceptedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions).catch(function(error) {
                    assert(error.status === 403, 'Wrong error = ' + JSON.stringify(error));
                    return 'Not participant';
                });
            }).then((response) => {
                assert(response === 'Not participant', 'Wrong response = ' + response);
                return userClient.investibles.lock(marketInvestibleId);
            }).then(() => {
                return userClient.investibles.update(marketInvestibleId, investible.name, investible.description, null, null, [userId, adminId]);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId})
                    .then((payload) => response);
            }).then(() => getMessages(userConfiguration)
            ).then((messages) => {
                // Note both of these messages should have already been there even before the assignment change
                const unread = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + marketInvestibleId;
                });
                assert(unread && unread.level === 'RED', 'changing assignment should mark unread');
                const helpAssign = messages.find(obj => {
                    return (obj.type_object_id === 'USER_ASSIGNED_EMPTY_' + adminId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(helpAssign && helpAssign.level === 'RED', 'changing assignment should create assigned empty notification');
                assert(helpAssign.text === 'Please vote for an assignment for Tester Uclusion', 'incorrect text ' + helpAssign.text);
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const helpAssign = messages.find(obj => {
                    return (obj.type_object_id === 'USER_ASSIGNED_EMPTY_' + adminId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(!helpAssign, 'USER_ASSIGNED_EMPTY gone after investment');
                stateOptions.current_stage_id = inDialogStage.id;
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then((response) => {
                assert(response.success_message === 'Investible state updated', 'Should be able to put accepted - wrong response = ' + response);
                return accountClient.markets.createMarket(initiativeOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === initiativeOptions.name, 'Name is incorrect');
                assert(market.description === initiativeOptions.description, 'Description is incorrect');
                assert(market.account_name, 'Market should have an account name');
                return adminClient.markets.listStages();
            }).then((stageList) => {
                checkStages(initiativeStageNames, stageList);
                return adminClient.investibles.create('help salmon spawn', 'fish transport tube');
            }).then(() => {
                return adminClient.investibles.create('only one allowed', 'this one should fail').catch(function(error) {
                    assert(error.status === 403, 'Wrong error = ' + JSON.stringify(error));
                    return 'Not allowed';
                });
            }).then((response) => {
                assert(response === 'Not allowed', 'Wrong response = ' + response);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(300000);
    });
};