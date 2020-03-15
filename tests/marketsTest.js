import assert from 'assert'
import {getMessages, loginUserToAccount, loginUserToMarket} from "../src/utils";
import {arrayEquals, checkStages} from "./commonTestFunctions";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 3
    };
    const planningOptions = {
        name : 'fish planning',
        description: 'this is a fish planning market',
        market_type: 'PLANNING',
        investment_expiration: 1
    };
    const initiativeOptions = {
        name : 'fish initiative',
        description: 'this is a fish initiative',
        expiration_minutes: 20,
        market_type: 'INITIATIVE'
    };
    const plannedStageNames = ['In Dialog', 'Accepted', 'In Review', 'Blocked', 'Verified', 'Not Doing'];
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
            let archivedStage;
            let inDialogStage;
            let notDoingStage;
            let stateOptions;
            let investible;
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
            }).then(() => {
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const warnExpiring = messages.find(obj => {
                    return obj.type_object_id === 'DIALOG_CLOSING_' + createdMarketId;
                });
                assert(warnExpiring, 'Should be warned of market closing');
                // Have 3 minutes to get here so that can receive the market update for the market expiring
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.expiration_minutes === marketOptions.expiration_minutes, 'expiration_minutes is incorrect');
                assert(market.account_name, 'Market should have an account name');
                assert(market.market_stage === 'Inactive', 'Market inactive after expires');
                return accountClient.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                console.log(`logging into planning market ${createdMarketId}`);
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
                console.log(`locking market ${createdMarketId}`);
                return adminClient.markets.lock();
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(({ event_type: 'market', object_id: createdMarketId}));
            }).then(() => {
                console.log(`Locking market ${createdMarketId} and breaking lock with same user`);
                return adminClient.markets.lock(true);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(({ event_type: 'market', object_id: createdMarketId}));
            }).then(() => {
                return adminClient.markets.updateMarket({name: 'See if can change name', description: 'See if can change description'});
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(({ event_type: 'market', object_id: createdMarketId}));
            }).then(() => {
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.updated_by_you, 'Market should have been updated by marked admin');
                assert(market.name === 'See if can change name', 'Name is incorrect');
                assert(market.description === 'See if can change description', 'Description is incorrect');
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
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                investible = fullInvestible.investible;
                const marketInfo = fullInvestible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                assert(arrayEquals(marketInfo.assigned, [userId]), 'assigned should be correct');
                inDialogStage = globalStages.find(stage => { return stage.allows_investment });
                assert(marketInfo.stage === inDialogStage.id, 'Instead of ' + marketInfo.stage + ' which is ' + marketInfo.stage_name);
                acceptedStage = globalStages.find(stage => { return stage.name === 'Accepted'});
                archivedStage = globalStages.find(stage => { return stage.appears_in_market_summary });
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
                return adminClient.markets.updateInvestment(marketInvestibleId, 50, 0, null, 1);
            }).then(() => {
                // This first one that the investment was created
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investment', object_id: createdMarketId});
            }).then(() => {
                // Now a second one that investment was deleted since investment expiration is 1 minute
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investment', object_id: createdMarketId});
            }).then(() => {
                notDoingStage = globalStages.find(stage => { return !stage.appears_in_market_summary && !stage.appears_in_context});
                stateOptions = {
                    current_stage_id: inDialogStage.id,
                    stage_id: notDoingStage.id
                };
                return userClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const market_info = market_infos[0];
                const { assigned, stage } = market_info;
                assert(!assigned, 'Moving to Not Doing clears assignments');
                assert(stage === notDoingStage.id, 'Should be in Not Doing stage');
                return userClient.investibles.lock(marketInvestibleId);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investible', object_id: createdMarketId});
            }).then(() => {
                return userClient.investibles.lock(marketInvestibleId, true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investible', object_id: createdMarketId});
            }).then(() => {
                return userClient.investibles.update(marketInvestibleId, investible.name, investible.description, null, null, [adminId]);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}])
                    .then((payload) => response);
            }).then(() => {
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const market_info = market_infos[0];
                const { assigned, stage } = market_info;
                assert(assigned[0] === adminId, 'Should be assigned');
                assert(stage === inDialogStage.id, 'Should be in voting stage');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const unread = messages.find(obj => {
                    return (obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(unread && unread.level === 'RED', 'changing assignment should mark unvoted');
                const helpAssign = messages.find(obj => {
                    return (obj.type_object_id === 'NO_PIPELINE_' + createdMarketId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(helpAssign && helpAssign.level === 'RED', 'changing assignment notify no pipeline');
                assert(helpAssign.text === 'Please assign a votable option to yourself', 'incorrect text ' + helpAssign.text);
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0, null, 1);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const helpAssign = messages.find(obj => {
                    return (obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(!helpAssign, 'NOT_FULLY_VOTED gone after investment');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === 'NEW_VOTES_' + marketInvestibleId;
                });
                assert(newVoting, 'Assigned should be notified of investment');
                stateOptions = {
                    current_stage_id: inDialogStage.id,
                    stage_id: archivedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.summaries.getMarketSummary();
            }).then((summaries) => {
                const summary = summaries[0];
                const { archived_budget_total: totalBudget } = summary;
                assert(totalBudget === 1, 'Summary should have budget from above');
                //Move it into blocking so that that the vote expiration code can be invoked - not testing here but will see if errors
                return userClient.investibles.createComment(marketInvestibleId, 'actually its not done', null, 'ISSUE');
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                console.log('Hiding market');
                return userClient.markets.hide();
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_capability', object_id: createdMarketId});
            }).then(() => {
                return userClient.markets.listUsers();
            }).then((users) => {
                const myUser = users.find(obj => {
                    return obj.id === userId;
                });
                assert(myUser.market_hidden, 'market should be hidden');
                return accountClient.markets.createMarket(initiativeOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
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
        }).timeout(600000);
    });
};
