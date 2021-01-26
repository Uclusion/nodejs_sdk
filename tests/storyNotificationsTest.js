import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    const marketOptions = {
        name: 'Test story notifications',
        description: 'This is a test of notifications in a planning market.',
        market_type: 'PLANNING',
    };

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
            await promise.then((client) => {
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
                return adminClient.investibles.create('A test story',
                    'See if notifications work.', null, [adminId]);
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
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
                return userClient.investibles.createComment(marketInvestibleId, 'body of my comment',
                    null, 'QUESTION');
            }).then((comment) => {
                questionCommentId = comment.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
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
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
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
                assert(!openComment, 'Changing stage removes issue notification');
                const inReview = globalStages.find(stage => { return !stage.appears_in_market_summary
                    && stage.appears_in_context && !stage.assignee_enter_only && !stage.allows_investment; });
                const stateOptions = {
                    current_stage_id: acceptedStage.id,
                    stage_id: inReview.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + marketInvestibleId;
                });
                assert(review, 'Moving to in review with no required reviewers is view level');
                return adminClient.investibles.createComment(marketInvestibleId, 'body of my todo',
                    null, 'TODO');
            }).then((comment) => {
                todoCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + marketInvestibleId;
                });
                assert(!review, 'Opening a TODO has removed the review notification');
                return adminClient.investibles.updateComment(todoCommentId, undefined, true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + marketInvestibleId;
                });
                assert(!review, 'Resolving the last with open question does not send please review');
                return adminClient.investibles.updateComment(questionCommentId, undefined, true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const review = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + marketInvestibleId;
                });
                assert(review, 'Resolving the last TODO and open question re-sends the review notification');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


