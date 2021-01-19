import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    const marketOptions = {
        name: 'Test story notifications',
        description: 'This is a test of notifications in a planning market.',
        market_type: 'PLANNING',
    };

    const inlineMarketOptions = {
        name: 'NA',
        description: 'NA',
        market_type: 'DECISION',
    };

    describe('#doInlineNotifications', () => {
        it('should do persistent inline notifications without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let accountClient;
            let adminClient;
            let userClient;
            let userId;
            let userExternalId;
            let adminId;
            let adminExternalId;
            let createdMarketId;
            let marketInvestibleId;
            let createdMarketInvite;
            let createdCommentId;
            let inlineMarketId;
            let inlineAdminClient;
            let inlineInvestibleId;
            let inlineUserClient;
            let inlineUserId;
            let globalStages;
            await promise.then((client) => {
                accountClient = client;
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
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return adminClient.investibles.createComment(marketInvestibleId, 'body of my comment',
                    null, 'QUESTION');
            }).then((comment) => {
                createdCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + createdCommentId;
                });
                assert(openComment, 'Notification to help with assignees question');
                inlineMarketOptions.parent_comment_id = createdCommentId;
                return accountClient.markets.createMarket(inlineMarketOptions);
            }).then((response) => {
                inlineMarketId = response.market.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return loginUserToMarket(userConfiguration, inlineMarketId);
            }).then((client) => {
                inlineUserClient = client;
                return userClient.users.get();
            }).then((user) => {
                inlineUserId = user.id;
                return loginUserToMarket(adminConfiguration, inlineMarketId);
            }).then((client) => {
                inlineAdminClient = client;
                return inlineAdminClient.investibles.create('A test option',
                    'See if inline notifications work.');
            }).then((investible) => {
                inlineInvestibleId = investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: inlineMarketId});
            }).then(() => {
                return inlineAdminClient.markets.listStages();
            }).then((stageList) => {
                globalStages = stageList;
                const createdStage = globalStages.find(stage => { return !stage.allows_investment; });
                const inDialogStage = globalStages.find(stage => { return stage.allows_investment; });
                const stateOptions = {
                    current_stage_id: createdStage.id,
                    stage_id: inDialogStage.id
                };
                return inlineAdminClient.investibles.stateChange(inlineInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: inlineMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const unread = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + inlineInvestibleId;
                });
                assert(unread, 'Should get new option notification');
                const mention = {
                    user_id: userId,
                    external_id: userExternalId,
                    market_id: createdMarketId,
                };
                return adminClient.investibles.updateComment(createdCommentId, 'new body', undefined,
                    undefined, [mention]);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const unread = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_' + inlineInvestibleId;
                });
                assert(unread, 'Should still have new option notification');
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(vote, 'Should receive not fully voted now that mentioned');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


