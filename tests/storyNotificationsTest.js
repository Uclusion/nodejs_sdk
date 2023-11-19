import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {

    describe('#doPlanningNotifications', () => {
        it('should do persistent Planning notifications without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let userId;
            let userExternalId;
            let adminId;
            let adminExternalId;
            let createdMarketId;
            let marketInvestibleId;
            let createdMarketInvite;
            let questionCommentId;
            let todoCommentId;
            let reportCommentId;
            let globalStages;
            let acceptedStage;
            let resolvedStage;
            let inApprovalStage;
            let requiresInputStage;
            await promise.then((client) => {
                const marketOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A'
                };
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                adminExternalId = user.external_id;
                return adminClient.investibles.create({
                    groupId: createdMarketId,
                    name: 'A test story', description: 'See if notifications work.',
                    assignments: [adminId]});
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                const marketInfo = investible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                assert(marketInfo.accepted, 'Self-assigned automatically accepts');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                userClient = client;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + marketInvestibleId;
                });
                assert(vote, 'Should receive not fully voted for existing stories on login');
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                const mention = {
                    user_id: adminId,
                    external_id: adminExternalId,
                };
                return userClient.investibles.createComment(marketInvestibleId, createdMarketId, 'body of my comment',
                    null, 'QUESTION', undefined, [mention]);
            }).then((comment) => {
                questionCommentId = comment.id;
                // Also wait the push of the capability from the mention
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([
                    {event_type: 'notification', object_id: adminExternalId},
                    {event_type: 'market_capability', object_id: createdMarketId}]);
            }).then(() => {
                return userClient.markets.listUsers();
            }).then((users) => {
                const myAdminUser = users.find(obj => {
                    return obj.id === adminId;
                });
                assert(myAdminUser.mentioned_notifications, 'admin should show as mentioned');
                return getMessages(adminConfiguration);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(openComment, 'Must respond to user opening comment');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + marketInvestibleId;
                });
                assert(!vote, 'Not fully voted removed if leave comment');
                return adminClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                // Also wait the push of the capability from removing the mention
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([
                    {event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'market_capability', object_id: createdMarketId}]);
            }).then(() => {
                return userClient.markets.listUsers();
            }).then((users) => {
                const myAdminUser = users.find(obj => {
                    return obj.id === adminId;
                });
                assert(!myAdminUser.mentioned_notifications || myAdminUser.mentioned_notifications.length === 0,
                    'admin should now not show as mentioned');
                return getMessages(adminConfiguration);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(!openComment, 'Resolving comment removes issue notification');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + marketInvestibleId;
                });
                assert(vote, 'Should receive not fully voted when comment resolved');
                return userClient.markets.updateInvestment(marketInvestibleId, 50, 0);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${marketInvestibleId}_${userId}`;
                });
                assert(newVoting, 'Assignee should be notified of investment');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + createdMarketId;
                });
                assert(!vote, 'Not fully voted removed on approval');
                return userClient.markets.removeInvestment(marketInvestibleId);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${marketInvestibleId}_${userId}`;
                });
                assert(!newVoting, 'Unread vote should clear when remove investment');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + marketInvestibleId;
                });
                assert(vote, 'Removing investment restores not fully voted');
                return userClient.investibles.updateComment(questionCommentId, undefined, false);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_JOB_APPROVAL_REQUEST_' + marketInvestibleId;
                });
                assert(!vote, 'Unresolving comment removes not fully voted');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(openComment, 'Unresolving comment restores issue notification');
                return adminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                acceptedStage = globalStages.find(stage => stage.assignee_enter_only);
                inApprovalStage = globalStages.find(stage => stage.allows_investment);
                resolvedStage = globalStages.find(stage => !stage.allows_tasks);
                requiresInputStage = globalStages.find(stage => !stage.allows_issues && stage.move_on_comment);
                const stateOptions = {
                    current_stage_id: inApprovalStage.id,
                    stage_id: acceptedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(openComment, 'Changing to non final stage preserves issue notification');
                const stateOptions = {
                    current_stage_id: acceptedStage.id,
                    stage_id: resolvedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return userClient.investibles.createComment(marketInvestibleId, createdMarketId, 'body of my todo',
                    null, 'TODO');
            }).then((comment) => {
                todoCommentId = comment.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(inApprovalStage.id === stage, 'Investible should move to approval');
                return adminClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                // Resolving this question also sends unread unresolved
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment',
                    object_id: createdMarketId}, {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(!openComment, 'Resolving question removes issue notification');
                return adminClient.investibles.createComment(marketInvestibleId, createdMarketId,
                    'body of my assisted comment', null, 'QUESTION');
            }).then((comment) => {
                questionCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(requiresInputStage.id === stage, 'Investible should move to assistance');
                return userClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessages([
                    {event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(inApprovalStage.id === stage, 'Investible should move back to former');
                return userClient.investibles.updateComment(questionCommentId, undefined, false);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(requiresInputStage.id === stage, 'Investible should move again to assistance');
                return userClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.createComment(marketInvestibleId, createdMarketId,
                    'body of my assisted comment', null, 'SUGGEST');
            }).then((comment) => {
                questionCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(requiresInputStage.id === stage, 'Investible moves to assistance for suggest');
                return userClient.investibles.updateComment(questionCommentId, undefined, undefined,
                    undefined, undefined, 'TODO');
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const { market_infos } = fullInvestible;
                const marketInfo = market_infos[0];
                const { stage } = marketInfo;
                assert(inApprovalStage.id === stage, 'Investible moves back to former for type change');
                const stateOptions = {
                    current_stage_id: inApprovalStage.id,
                    stage_id: resolvedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                // We get a unread_resolved from auto closing the to-do above
                return userConfiguration.webSocketRunner.waitForReceivedMessages([
                    {event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return adminClient.investibles.createComment(marketInvestibleId, createdMarketId,
                    'review my job', null, 'REPORT');
            }).then((comment) => {
                reportCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment',
                    object_id: createdMarketId}, {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_REVIEWABLE_' + reportCommentId;
                });
                assert(review, 'Resolving the investible with a progress report creates review');
                const resolved = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_RESOLVED_' + todoCommentId;
                });
                assert(resolved, 'Moving the investible resolved the todo and so warned the creator');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


