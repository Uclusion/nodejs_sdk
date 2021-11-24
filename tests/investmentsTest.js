import assert from 'assert';
import { arrayEquals } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    const fishOptions = {
        name: 'fish',
        description: 'this is a fish market',
        market_type: 'DECISION',
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
            let createdMarketInvite;
            await promise.then((client) => {
                return client.markets.createMarket(fishOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create({name: 'salmon', description: 'good on bagels'});
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
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
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return userClient.markets.updateInvestment(marketInvestibleId, 100, 0);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${marketInvestibleId}_${userId}`;
                });
                assert(newVoting, 'Moderator should be notified of investment');
                return userClient.investibles.createComment(marketInvestibleId, 'body of my comment', null, 'ISSUE');
            }).then((comment) => {
                parentCommentId = comment.id;
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                assert(comment.comment_type === 'ISSUE', 'comment_type incorrect');
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'notification'}]);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_' + parentCommentId)&&(obj.level === 'RED');
                });
                assert(investibleIssue, 'No investible issue notification');
                return adminClient.investibles.createComment(marketInvestibleId,'a reply comment', parentCommentId);
            }).then((comment) => {
                assert(comment.reply_id === parentCommentId, 'updated reply_id incorrect');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + parentCommentId;
                });
                assert(!investibleIssue.is_highlighted && investibleIssue.level === 'BLUE', 'Issue notification de-highlighted and informational by reply');
                const mention = {
                    user_id: userId,
                    external_id: userExternalId,
                };
                return userClient.investibles.updateComment(parentCommentId, 'new body', true, undefined, [mention]);
            }).then((comment) => {
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'notification'}])
                    .then(() => comment);
            }).then((comment) => {
                assert(comment.body === 'new body', 'updated comment body incorrect');
                assert(comment.mentions.length === 1, 'mentions should contain just one person');
                assert(comment.mentions[0].user_id === userId, 'mention should just be for the user id');
                assert(comment.resolved, 'updated resolved incorrect');
                assert(comment.children, 'now parent should have children');
                assert(comment.version === 4, `update, reply and resolve should each bump version but ${comment.version}`);
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_' + parentCommentId)&&(obj.level === 'RED')&&(obj.associated_object_id === marketInvestibleId);
                });
                assert(!investibleIssue, 'Investible issue notification should have been deleted');
                const investibleIssueResolved = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_RESOLVED_' + parentCommentId)&&(obj.associated_object_id === marketInvestibleId);
                });
                assert(!investibleIssueResolved, 'Resolution should only notify creator');
                const mention = {
                    user_id: userId,
                    external_id: userExternalId,
                }
                return adminClient.investibles.createComment(null, 'comment to fetch', null,
                    'QUESTION', null, [mention]);
            }).then((comment) => {
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId})
                    .then(() => comment);
            }).then((comment) => {
                assert(comment.body === 'comment to fetch', 'comment body incorrect');
                assert(comment.comment_type === 'QUESTION', 'comment should be question');
                assert(comment.mentions.length === 1 , 'mentions should include just the one');
                assert(comment.mentions[0].user_id === userId, 'mention should just be for the user id');
                assert(!comment.resolved, 'QUESTION resolved incorrect');
                return userClient.investibles.getMarketComments([comment.id]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === createdMarketId, 'market was not set properly on the comment');
                return adminClient.investibles.lock(marketInvestibleId);
            }).then((fullInvestible) => {
                const { investible } = fullInvestible;
                assert(investible.name === 'salmon', 'lock investible name not passed correctly');
                assert(investible.description === 'good on bagels', 'lock investible description not passed correctly');
                return adminClient.investibles.update(marketInvestibleId, updateFish.name, updateFish.description, updateFish.label_list);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investible', object_id: createdMarketId})
                  .then(() => response);
            }).then((response) => {
                const { investible } = response;
                assert(investible.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(investible.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                assert(arrayEquals(investible.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
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
        }).timeout(240000);
    });
};


