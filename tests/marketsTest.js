import assert from 'assert'
import {getMessages, loginUserToAccount, loginUserToMarket, loginUserToMarketInvite} from "../src/utils";
import {arrayEquals, checkStages} from "./commonTestFunctions";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        market_type: 'DECISION',
        expiration_minutes: 4
    };
    const unnamedOptions = {
        name : 'my investible in unnamed',
        description: 'this is an investible in an unnamed market',
        market_type: 'PLANNING',
        market_sub_type: 'UNNAMED'
    };
    const planningOptions = {
        name : 'fish planning',
        description: 'this is a fish planning market',
        market_type: 'PLANNING',
        market_sub_type: 'TEST',
        investment_expiration: 1
    };
    const initiativeOptions = {
        name : 'fish initiative',
        description: 'this is a fish initiative',
        expiration_minutes: 20,
        market_type: 'INITIATIVE'
    };
    const plannedStageNames = ['In Dialog', 'Accepted', 'In Review', 'Blocked', 'Verified', 'Not Doing',
        'Further Work', 'Requires Input'];
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
            let marketInvestibleTwoId;
            let globalStages;
            let acceptedStage;
            let archivedStage;
            let inDialogStage;
            let notDoingStage;
            let stateOptions;
            let investible;
            let marketInfo;
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(unnamedOptions);
            }).then((marketResult) => {
                const {market, stages, investible, presence} = marketResult;
                assert(market, 'market does not exist');
                assert(stages, 'stages does not exist');
                assert(investible, 'no investible');
                assert(presence, 'no user');
                return accountClient.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessages(
                    [{event_type: 'market', object_id: createdMarketId}, {event_type: 'notification'}]);
            }).then(() => {
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const warnExpiring = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_COLLABORATION_' + createdMarketId;
                });
                if (!warnExpiring) {
                    //No idea what is going on but maybe receiving some very old push somehow so try again
                    return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'})
                        .then(() => getMessages(adminConfiguration)).then((messages) => {
                                const warnExpiring2 = messages.find(obj => {
                                    return obj.type_object_id === 'UNREAD_COLLABORATION_' + createdMarketId;
                                });
                                assert(warnExpiring2, `Now get closed or closing instead of ${JSON.stringify(messages)}`);
                                return adminConfiguration.webSocketRunner.waitForReceivedMessage({
                                    event_type: 'market',
                                    object_id: createdMarketId
                                });
                            });
                }
                assert(warnExpiring, `Should get closed or closing (timing as to which) instead of ${JSON.stringify(messages)}`);
                // Have 4 minutes to get here so that can receive the market update for the market expiring
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.expiration_minutes === marketOptions.expiration_minutes, 'expiration_minutes is incorrect');
                assert(market.account_name, 'Market should have an account name');
                assert(market.market_stage === 'Cancelled', 'Market Cancelled after expires');
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
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                checkStages(plannedStageNames, stageList);
                acceptedStage = globalStages.find(stage => { return stage.name === 'Accepted'});
                return adminClient.markets.updateStage(acceptedStage.id, 1)
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(({ event_type: 'stage', object_id: createdMarketId}));
            }).then(() => {
                console.log(`locking market ${createdMarketId}`);
                return adminClient.markets.lock();
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
                return loginUserToMarketInvite(userConfiguration, market.invite_capability);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create({name: 'salmon spawning', description: 'plan to catch',
                    assignments: [userId]});
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
                archivedStage = globalStages.find(stage => { return stage.appears_in_market_summary });
                return adminClient.markets.updateInvestment(marketInvestibleId, 50, 0, null, 1);
            }).then(() => {
                // This first one that the investment was created
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investment', object_id: createdMarketId});
            }).then(() => {
                // Now a second one that investment was deleted since investment expiration is 1 minute
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investment', object_id: createdMarketId});
            }).then(() => {
                // Turn off investment expiration 1m so it can't affect the rest of this test
                return adminClient.markets.updateMarket({investment_expiration: 30});
            }).then(() => {
                notDoingStage = globalStages.find(stage => { return !stage.allows_assignment && stage.close_comments_on_entrance });
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
                return userClient.investibles.updateAssignments(marketInvestibleId, [adminId]);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}])
                    .then(() => response);
            }).then(() => {
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                marketInfo = market_infos[0];
                const { assigned, stage } = marketInfo;
                assert(assigned[0] === adminId, 'Should be assigned');
                assert(stage === inDialogStage.id, 'Should be in voting stage');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const unread = messages.find(obj => {
                    return (obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(unread && unread.level === 'RED', `changing assignment should mark unvoted for ${marketInvestibleId}`);
                assert(unread.market_investible_id === marketInfo.id, 'notification is for market info');
                assert(unread.market_investible_version === marketInfo.version, 'notification version should match market info version');
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0, null, 1);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
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
                    return obj.type_object_id === 'UNACCEPTED_ASSIGNMENT_' + marketInvestibleId;
                });
                assert(newVoting, 'Assigned should be notified of story');
                stateOptions = {
                    current_stage_id: inDialogStage.id,
                    stage_id: acceptedStage.id
                };
                return userClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.create({name: 'check stage update', description: 'now',
                    assignments: [adminId]});
            }).then((investible) => {
                marketInvestibleTwoId = investible.investible.id;
                stateOptions = {
                    current_stage_id: inDialogStage.id,
                    stage_id: acceptedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleTwoId, stateOptions);
            }).then(() => {
                stateOptions = {
                    current_stage_id: acceptedStage.id,
                    stage_id: archivedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                //Move it into blocking so that that the vote expiration code can be invoked - not testing here but will see if errors
                return userClient.investibles.createComment(marketInvestibleId, 'actually its not done', null, 'ISSUE');
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
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
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(1200000);
    });
};
