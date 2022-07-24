import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    describe('#doInitiativeNotifications', () => {
        it('should do persistent Initiative notifications without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let inlineUserClient;
            let inlineAdminClient;
            let userId;
            let userExternalId;
            let adminId;
            let adminExternalId;
            let marketInvestibleId;
            let createdMarketId;
            let createdMarketInvite;
            let inlineCreatedMarketId;
            let inlineCreatedMarketInvite;
            let createdCommentId;
            let adminAccountClient;
            await promise.then((client) => {
                adminAccountClient = client;
                const planningOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A',
                    market_sub_type: 'TEST'
                };
                return client.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                return client.investibles.createComment(undefined, 'Do the fish thing.', null,
                    'SUGGEST', null, null, null, 'INITIATIVE',
                    false, true);
            }).then((response) => {
                inlineCreatedMarketId = response.market.id;
                inlineCreatedMarketInvite = response.market.invite_capability;
                marketInvestibleId = response.investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                console.log(`Logging admin into market ${inlineCreatedMarketId}`);
                return loginUserToMarket(adminConfiguration, inlineCreatedMarketId);
            }).then((client) => {
                inlineAdminClient = client;
                return inlineAdminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                adminExternalId = user.external_id;
                console.log(`Logging user into market ${inlineCreatedMarketId}`);
                return loginUserToMarketInvite(userConfiguration, inlineCreatedMarketInvite);
            }).then((client) => {
                inlineUserClient = client;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineCreatedMarketId;
                });
                assert(vote, 'Should receive not fully voted on login to Initiative');
                return inlineUserClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return inlineUserClient.investibles.createComment(marketInvestibleId, 'body of my comment',
                    null, 'QUESTION');
            }).then((comment) => {
                createdCommentId = comment.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + createdCommentId;
                });
                assert(openComment, 'Must respond to user opening comment');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineCreatedMarketId;
                });
                assert(vote, 'Not fully voted remains if leave comment');
                return inlineAdminClient.investibles.updateComment(createdCommentId, undefined, true);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: inlineCreatedMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + createdCommentId;
                });
                assert(!openComment, 'Resolving comment removes issue notification');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineCreatedMarketId;
                });
                assert(vote, 'Should receive not fully voted when comment resolved');
                return inlineUserClient.markets.updateInvestment(marketInvestibleId, -50, 0);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: adminExternalId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${marketInvestibleId}_${userId}`;
                });
                assert(newVoting, 'Moderator should be notified of investment');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineCreatedMarketId;
                });
                assert(!vote, 'Not fully voted removed on voting');
                return inlineUserClient.markets.removeInvestment(marketInvestibleId);
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineCreatedMarketId;
                });
                assert(vote, 'Removing investment restores not fully voted');
                return inlineUserClient.investibles.updateComment(createdCommentId, undefined, false);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: inlineCreatedMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineCreatedMarketId;
                });
                assert(vote, 'Unresolving comment does not remove not fully voted');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + createdCommentId;
                });
                assert(openComment, 'Unresolving comment restores issue notification');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


