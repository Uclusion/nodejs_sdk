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
            let globalStages;
            let acceptedStage;
            let resolvedStage;
            let inReviewStage;
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId;
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId;
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId;
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId;
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + marketInvestibleId;
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
                acceptedStage = globalStages.find(stage => { return stage.assignee_enter_only; });
                const inDialogStage = globalStages.find(stage => { return stage.allows_investment; });
                resolvedStage = globalStages.find(stage => {return stage.appears_in_market_summary});
                const stateOptions = {
                    current_stage_id: inDialogStage.id,
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
                inReviewStage = globalStages.find(stage => { return !stage.appears_in_market_summary
                    && stage.appears_in_context && !stage.assignee_enter_only && !stage.allows_investment; });
                const stateOptions = {
                    current_stage_id: acceptedStage.id,
                    stage_id: inReviewStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_REVIEWABLE_' + marketInvestibleId;
                });
                assert(review, 'Moving to in review with no required reviewers is view level');
                return userClient.investibles.createComment(marketInvestibleId, createdMarketId, 'body of my todo',
                    null, 'TODO');
            }).then((comment) => {
                todoCommentId = comment.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_REVIEWABLE_' + todoCommentId;
                });
                assert(review, 'Opening a TODO alerts assigned');
                return adminClient.investibles.updateComment(todoCommentId, undefined, true);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_REVIEWABLE_' + todoCommentId;
                });
                assert(!review, 'Resolving the todo removes the notification');
                return adminClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + questionCommentId;
                });
                assert(!openComment, 'Resolving question removes issue notification');
                const stateOptions = {
                    current_stage_id: inReviewStage.id,
                    stage_id: resolvedStage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_REVIEWABLE_' + marketInvestibleId;
                });
                assert(!review, 'Resolving the investible removes review');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


