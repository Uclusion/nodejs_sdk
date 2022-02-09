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
                return adminClient.investibles.create({name: 'A test story', description: 'See if notifications work.',
                    assignments: [adminId]});
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
                    return obj.type_object_id === 'ISSUE_' + createdCommentId;
                });
                assert(openComment, 'Notification to help with assignees question');
                inlineMarketOptions.parent_comment_id = createdCommentId;
                return accountClient.markets.createMarket(inlineMarketOptions);
            }).then((response) => {
                inlineMarketId = response.market.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_capability', object_id: inlineMarketId});
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
                return inlineAdminClient.investibles.create({name: 'A test option',
                    description: 'See if inline notifications work.'});
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
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(vote && vote.level === 'YELLOW', 'Should get delayable not fully voted notification');
                const mention = {
                    user_id: userId,
                    external_id: userExternalId,
                };
                return adminClient.investibles.updateComment(createdCommentId, 'new body', undefined,
                    undefined, [mention]);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return inlineUserClient.markets.updateAbstain(true);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_capability', object_id: inlineMarketId});
            }).then(() => {
                return userClient.users.get();
            }).then((user) => {
                assert(user.abstain, 'Abstain marks the user so');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(vote && vote.level === 'RED', 'Should receive critical not fully voted now that mentioned');
                return inlineUserClient.markets.updateInvestment(inlineInvestibleId, 100, 0);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'notification',
                    object_id: adminExternalId}, {event_type: 'market_capability', object_id: inlineMarketId}]);
            }).then(() => {
                return userClient.users.get();
            }).then((user) => {
                assert(!user.abstain, 'Investing marks the user not abstained');
                return getMessages(userConfiguration);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const voted = messages.find(obj => {
                    return obj.type_object_id === 'FULLY_VOTED_' + inlineMarketId;
                });
                assert(voted, 'Fully voted when all voted');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


