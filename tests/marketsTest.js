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
    const plannedStageNames = [ 'Created', 'In Dialog', 'In Progress', 'Archived'];
    describe('#doCreate and asynchronously expire market', () => {
        it('should create market without error', async() => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let accountClient;
            let createdMarketId;
            let userId;
            let adminId;
            let marketInvestibleId;
            let globalStages;
            let progressStage;
            let currentStage;
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
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: createdMarketId});
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
                currentStage = globalStages.find(stage => { return stage.name === 'Created'});
                assert(marketInfo.stage === currentStage.id, 'Instead of ' + marketInfo.stage + ' which is ' + marketInfo.stage_name);
                assert(!marketInfo.appears_in_market_summary, 'not in tabs yet');
                progressStage = globalStages.find(stage => { return stage.name === 'In Progress'});
                stateOptions = {
                    current_stage_id: currentStage.id,
                    stage_id: progressStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions).catch(function(error) {
                    assert(error.status === 403, 'Wrong error = ' + JSON.stringify(error));
                    return 'Not participant';
                });
            }).then((response) => {
                assert(response === 'Not participant', 'Wrong response = ' + response);
                return userClient.investibles.update(marketInvestibleId, investible.name, investible.description, null, null, [userId, adminId]);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId})
                    .then((payload) => response);
            }).then(() => getMessages(userConfiguration)
            ).then((messages) => {
                const unread = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_UNREAD_' + marketInvestibleId;
                });
                assert(unread && unread.level === 'RED', 'changing assignment should mark unread');
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then((response) => {
                assert(response.success_message === 'Investible state updated', 'Should be able to put in progress - wrong response = ' + response);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(300000);
    });
};