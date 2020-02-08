import assert from 'assert';
import { arrayEquals, sleep } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, getMessages} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration, numUsers) {
    const fishOptions = {
        name: 'fish',
        description: 'this is a fish market',
        expiration_minutes: 30
    };
    const updateFish = {
        name: 'pufferfish',
        description: 'possibly poisonous',
        label_list: ['freshwater', 'spawning']
    };

    describe('#doInvestment', () => {
        it('should create investment without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let userId;
            let userExternalId;
            let createdMarketId;
            let marketInvestibleId;
            let globalStages;
            let parentCommentId;
            await promise.then((client) => {
                return client.markets.createMarket(fishOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create('salmon', 'good on bagels');
            }).then((investibleId) => {
                marketInvestibleId = investibleId;
                console.log('Investible ID is ' + marketInvestibleId);
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
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
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                if (!invalidVoting) {
                    console.log(messages);
                }
                assert(invalidVoting, 'Should be not voted till first investment');
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification', object_id: userExternalId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!invalidVoting, 'Invalid vote gone after first investment');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === 'NEW_VOTES_' + marketInvestibleId;
                });
                assert(newVoting, 'Moderator should be notified of investment');
                return userClient.investibles.createComment(marketInvestibleId, 'body of my comment', null, 'ISSUE');
            }).then((comment) => {
                parentCommentId = comment.id;
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                assert(comment.comment_type === 'ISSUE', 'comment_type incorrect');
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'notification'}])
                  .then((payload) => comment);
            }).then((comment) => {
                return adminClient.investibles.createComment(marketInvestibleId,'a reply comment', comment.id);
            }).then((comment) => {
                assert(comment.reply_id === parentCommentId, 'updated reply_id incorrect');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_' + parentCommentId)&&(obj.level === 'RED')&&(obj.associated_object_id === marketInvestibleId);
                });
                assert(investibleIssue, 'No investible issue notification');
                return userClient.investibles.updateComment(parentCommentId, 'new body', true);
            }).then((comment) => {
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'notification'}])
                    .then((payload) => comment);
            }).then((comment) => {
                assert(comment.body === 'new body', 'updated comment body incorrect');
                assert(comment.resolved, 'updated resolved incorrect');
                assert(comment.children, 'now parent should have children');
                assert(comment.version === 3, 'update, reply and resolve should each bump version');
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_' + parentCommentId)&&(obj.level === 'RED')&&(obj.associated_object_id === marketInvestibleId);
                });
                assert(!investibleIssue, 'Investible issue notification should have been deleted');
                const investibleIssueResolved = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_RESOLVED_' + parentCommentId)&&(obj.level === 'YELLOW')&&(obj.associated_object_id === marketInvestibleId);
                });
                assert(investibleIssueResolved, 'Notification of resolution missing');
                return adminClient.investibles.createComment(null, 'comment to fetch', null, 'QUESTION');
            }).then((comment) => {
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId})
                    .then((payload) => comment);
            }).then((comment) => {
                assert(comment.body === 'comment to fetch', 'comment body incorrect');
                assert(comment.comment_type === 'QUESTION', 'comment should be question');
                assert(!comment.resolved, 'QUESTION resolved incorrect');
                return userClient.investibles.getMarketComments([comment.id]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === createdMarketId, 'market was not set properly on the comment');
                return adminClient.investibles.lock(marketInvestibleId);
            }).then((investible) => {
                assert(investible.name === 'salmon', 'lock investible name not passed correctly');
                assert(investible.description === 'good on bagels', 'lock investible description not passed correctly');
                return adminClient.investibles.update(marketInvestibleId, updateFish.name, updateFish.description, updateFish.label_list);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investible', object_id: createdMarketId})
                  .then((payload) => response);
            }).then((response) => {
                assert(response.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(response.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                assert(arrayEquals(response.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const investible = fullInvestible.investible;
                assert(investible.name === 'pufferfish', 'get market investible name incorrect');
                assert(!investible.updated_by_you, 'Market investible should have been updated by the admin not the user');
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                assert(arrayEquals(investible.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                const marketInfo = fullInvestible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                const current_stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                assert(marketInfo.stage === current_stage.id, 'Instead of ' + marketInfo.stage + ' which is ' + marketInfo.stage_name);
                assert(marketInfo.open_for_investment === true, 'open_for_investment true');
                return userClient.markets.removeInvestment(marketInvestibleId);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'investment', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => getMessages(userConfiguration)
            ).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(invalidVoting, 'Should be not voted after removing investment');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};


