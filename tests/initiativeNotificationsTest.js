import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    describe('#doInitiativeNotifications', () => {
        it('should do persistent Initiative notifications without error', async () => {
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
            let adminAccountClient;
            await promise.then((client) => {
                adminAccountClient = client;
                const planningOptions = {
                    market_type: 'PLANNING',
                    market_sub_type: 'TEST',
                    investment_expiration: 1
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
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                marketInvestibleId = response.investible.investible.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then((response) => {
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
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
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Should receive not fully voted on login to Initiative');
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.createComment(marketInvestibleId, 'body of my comment',
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Not fully voted remains if leave comment');
                return adminClient.investibles.updateComment(createdCommentId, undefined, true);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Should receive not fully voted when comment resolved');
                return userClient.markets.updateInvestment(marketInvestibleId, -50, 0);
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!vote, 'Not fully voted removed on voting');
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
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Removing investment restores not fully voted');
                return userClient.investibles.updateComment(createdCommentId, undefined, false);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
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


