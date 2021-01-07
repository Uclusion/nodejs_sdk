import assert from 'assert';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    const fishOptions = {
        name: 'notifications test',
        description: 'this is a decision market',
        market_type: 'DECISION',
        expiration_minutes: 30
    };

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
            await promise.then((client) => {
                return client.markets.createMarket(fishOptions);
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
                assert(vote, 'Should receive not fully voted on login to market');
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create('salmon', 'good on bagels');
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                console.log('Investible ID is ' + marketInvestibleId);
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: adminExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!vote, 'Un-promoted investible clears not fully voted');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const submitted = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_SUBMITTED_' + marketInvestibleId;
                });
                assert(submitted, 'Should receive investible submitted for new investible');
                return adminClient.investibles.createComment(marketInvestibleId, 'body of my comment', null, 'QUESTION');
            }).then((comment) => {
                createdCommentId = comment.id;
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + createdCommentId;
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
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + createdCommentId;
                });
                assert(!openComment, 'Resolving comment removes issue notification');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const submitted = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_SUBMITTED_' + marketInvestibleId;
                });
                assert(submitted, 'Should receive investible submitted when comment resolved');
                return adminClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                const currentStage = globalStages.find(stage => { return stage.name === 'Created'});
                const stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: currentStage.id,
                    stage_id: stage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: createdMarketId});
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
                    return obj.type_object_id === 'UNREAD_' + marketInvestibleId;
                });
                assert(newOption, 'View notification to check out the new option');
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(vote, 'Should receive not fully voted again now that investible promoted');
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0);
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
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


