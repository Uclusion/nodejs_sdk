import assert from 'assert';
import {loginUserToAccount, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {

    describe('#doDecisionNotifications', () => {
        it('should do persistent Dialog notifications without error', async () => {
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
            let createdCommentId;
            let globalStages;
            let globalCommentId;
            let adminAccountClient;
            await promise.then((client) => {
                adminAccountClient = client;
                const planningOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A',
                    market_sub_type: 'INTEGRATION_TEST'
                };
                return client.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                return client.investibles.createComment(undefined, createdMarketId, 'Is it done?',
                    null, 'QUESTION');
            }).then((comment) => {
                globalCommentId = comment.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                // Have to log the user in also, or he won't receive notifications
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                userClient = client;
                return client.users.get();
            }).then((user) => {
                userId = user.id;
                return userClient.markets.followGroup(createdMarketId, [{user_id: userId,
                    is_following: true}]);
            }).then(() => {
                const fishOptions = {
                    market_type: 'DECISION',
                    parent_comment_id: globalCommentId
                };
                return adminAccountClient.markets.createMarket(fishOptions);
            }).then((response) => {
                globalStages = response.stages;
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                // Immediately wait for the not fully voted notification to avoid race condition
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                adminExternalId = user.external_id;
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                userClient = client;
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!vote, 'Not fully voted not present till can vote on something');
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create({groupId: createdMarketId, name: 'salmon',
                    description: 'good on bagels'});
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                console.log('Investible ID is ' + marketInvestibleId);
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!vote, 'Un-promoted investible does not send not fully voted');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const submitted = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_SUBMITTED_' + marketInvestibleId;
                });
                assert(submitted, 'Should receive investible submitted for new investible');
                return adminClient.investibles.createComment(marketInvestibleId, createdMarketId,
                    'body of my comment', null, 'QUESTION');
            }).then((comment) => {
                createdCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId, type_object_id: `UNREAD_COMMENT_${createdCommentId}`});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_COMMENT_' + createdCommentId;
                });
                assert(openComment, 'Must respond to admin opening comment');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const submitted = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_SUBMITTED_' + marketInvestibleId;
                });
                assert(!submitted, 'Investible submitted removed if leave comment');
                return userClient.investibles.updateComment(createdCommentId, undefined, true);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment',
                    object_id: createdMarketId}, {event_type: 'notification', object_id: adminExternalId,
                    type_object_id: `INVESTIBLE_SUBMITTED_${marketInvestibleId}`}]);
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_COMMENT_' + createdCommentId;
                });
                assert(!openComment, 'Resolving comment removes issue notification');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const submitted = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_SUBMITTED_' + marketInvestibleId;
                });
                assert(submitted, 'Should receive investible submitted when comment resolved');
                const currentStage = globalStages.find(stage => { return stage.name === 'Created'});
                const stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: currentStage.id,
                    stage_id: stage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                // Wait on user to drain more notifications
                return userConfiguration.webSocketRunner.waitForReceivedMessages([
                    {event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const submitted = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_SUBMITTED_' + marketInvestibleId;
                });
                assert(!submitted, 'Investible submitted removed if promote investible');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const newOption = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_OPTION_' + marketInvestibleId;
                });
                assert(!newOption, 'View notification not required since will have not fully voted');
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Promoted investible does send not fully voted');
                return userClient.markets.updateInvestment(marketInvestibleId, 100,
                    0);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!vote, 'Not fully voted removed on approving an option');
                return userClient.investibles.createComment(marketInvestibleId, createdMarketId,
                    'body of my comment', null,
                    'ISSUE');
            }).then((comment) => {
                createdCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment',
                    object_id: createdMarketId}, {event_type: 'notification', object_id: userExternalId},
                    {event_type: 'market_investible', object_id: createdMarketId}]);
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Not fully voted remains after issue');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


