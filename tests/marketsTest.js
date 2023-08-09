import assert from 'assert'
import {getMessages, loginUserToAccount, loginUserToMarketInvite} from "../src/utils";
import {arrayEquals, checkStages} from "./commonTestFunctions";

module.exports = function(adminConfiguration, userConfiguration) {
    const plannedStageNames = ['In Dialog', 'Accepted', 'Blocked', 'Complete', 'Not Doing', 'Further Work',
        'Requires Input'];
    const initiativeStageNames = ['In Dialog'];
    describe('#doCreate market and asynchronously expire investments', () => {
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
            let globalCommentId;
            let globalAccountId;
            let marketInviteCapability;
            await promise.then((client) => {
                accountClient = client;
                const planningOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A',
                    market_sub_type: 'INTEGRATION_TEST',
                    investment_expiration: 1
                };
                return accountClient.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                globalAccountId = response.market.account_id;
                assert(response.market.name === 'Company A', 'market name is incorrect');
                console.log(`logging into planning market ${createdMarketId}`);
                marketInviteCapability = response.market.invite_capability;
                return loginUserToMarketInvite(adminConfiguration, marketInviteCapability);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.id === createdMarketId, 'ID is incorrect');
                assert(market.account_id === globalAccountId, 'Account is incorrect');
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                checkStages(plannedStageNames, stageList);
                acceptedStage = globalStages.find(stage => { return stage.name === 'Accepted'});
                return adminClient.markets.updateStage(acceptedStage.id, 1)
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(({ event_type: 'stage', object_id: createdMarketId}));
            }).then(() => {
                return loginUserToMarketInvite(userConfiguration, marketInviteCapability);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create({groupId: createdMarketId, name: 'salmon spawning', description: 'plan to catch',
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
                archivedStage = globalStages.find(stage => { return !stage.allows_tasks });
                return adminClient.markets.updateInvestment(marketInvestibleId, 50, 0, null, 1);
            }).then(() => {
                console.log(`waiting for created investment on ${marketInvestibleId}`);
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investment', object_id: createdMarketId});
            }).then(() => {
                console.log('waiting for that investment expired');
                // Now a second one since investment expiration is 1 minute
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
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification'}])
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
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const unread = messages.find(obj => {
                    return (obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + marketInvestibleId) && (obj.market_id_user_id.startsWith(createdMarketId));
                });
                assert(unread, `changing assignment should mark unvoted for ${marketInvestibleId}`);
                assert(unread.market_investible_id === marketInfo.id, 'notification is for market info');
                assert(unread.market_investible_version === marketInfo.version, 'notification version should match market info version');
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0, null, 1);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === 'FULLY_VOTED_' + marketInvestibleId;
                });
                assert(newVoting, 'Assigned should be notified of approval');
                stateOptions = {
                    current_stage_id: inDialogStage.id,
                    stage_id: acceptedStage.id
                };
                return userClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.create({groupId: createdMarketId, name: 'check stage update', description: 'now',
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
                return userClient.investibles.createComment(marketInvestibleId, createdMarketId, 'actually its not done', null, 'ISSUE');
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                //Need a comment to attach initiative to
                return userClient.investibles.createComment(marketInvestibleTwoId, createdMarketId,
                    'See if stage update messes up comments', null, 'SUGGEST');
            }).then((comment) => {
                globalCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                const initiativeOptions = {
                    market_type: 'INITIATIVE',
                    parent_comment_id: globalCommentId
                };
                return loginUserToAccount(userConfiguration)
                    .then((userAccountClient) => userAccountClient.markets.createMarket(initiativeOptions));
            }).then((response) => {
                return loginUserToMarketInvite(adminConfiguration, response.market.invite_capability);
            }).then((client) => {
                adminClient = client;
                return adminClient.markets.get();
            }).then((market) => {
                assert(market.market_type === 'INITIATIVE', 'Type is incorrect');
                assert(market.parent_comment_id === globalCommentId, 'Parent comment id is incorrect');
                assert(market.account_id === globalAccountId, 'Market should be in same account');
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
