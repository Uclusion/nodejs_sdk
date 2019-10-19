import assert from 'assert';
import { arrayEquals, sleep } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, getMessages} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration, numUsers) {
    const fishOptions = {
        name: 'fish',
        description: 'this is a fish market',
        expiration_minutes: 30,
        new_user_grant: 313
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
                return userClient.investibles.create('salmon', 'good on bagels');
            }).then((investibleId) => {
                marketInvestibleId = investibleId;
                console.log('Investible ID is ' + marketInvestibleId);
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId});
            }).then(() => {
                return adminClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                const current_stage = globalStages.find(stage => { return stage.name === 'Created'});
                const stage = globalStages.find(stage => { return stage.name === 'In Moderation'});
                let stateOptions = {
                    current_stage_id: current_stage.id,
                    stage_id: stage.id
                };
                return userClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminClient.users.grant(userId, 9000);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED'})
                    .then(() => response);
            }).then(() => {
                const current_stage = globalStages.find(stage => { return stage.name === 'In Moderation'});
                const stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: current_stage.id,
                    stage_id: stage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(invalidVoting, 'Should be not voted till first investment');
                return userClient.markets.updateInvestment(marketInvestibleId, 2000, 0);
            }).then((investment) => {
                assert(investment.quantity === 2000, 'investment quantity should be 2000');
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED', object_id: userId, indirect_object_id: createdMarketId});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(!invalidVoting, 'Invalid vote gone after first investment');
                return userClient.investibles.follow(marketInvestibleId, false);
            }).then((response) => {
                assert(response.following === true, 'follow should return true');
                return userClient.investibles.createComment(marketInvestibleId, 'body of my comment', null, null, true);
            }).then((comment) => {
                parentCommentId = comment.id;
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                assert(comment.is_official === false, 'comment should not be official');
                assert(comment.comment_type === 'ISSUE', 'comment_type incorrect');
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'INVESTIBLE_COMMENT_UPDATED'})
                  .then((payload) => comment);
            }).then((comment) => {
                return adminClient.investibles.createComment(marketInvestibleId,'a reply comment', comment.id);
            }).then((comment) => {
                assert(comment.reply_id === parentCommentId, 'updated reply_id incorrect');
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'INVESTIBLE_COMMENT_UPDATED'});
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_ISSUE_' + marketInvestibleId;
                });
                assert(investibleIssue, 'No investible issue notification');
                return userClient.investibles.updateComment(parentCommentId, 'new body', true);
            }).then((comment) => {
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'INVESTIBLE_COMMENT_UPDATED'})
                    .then((payload) => comment);
            }).then((comment) => {
                assert(comment.body === 'new body', 'updated comment body incorrect');
                assert(comment.comment_type === 'RESOLVED', 'updated comment_type incorrect');
                assert(comment.children, 'now parent should have children');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_ISSUE_' + marketInvestibleId;
                });
                assert(!investibleIssue, 'Investible issue notification should have been deleted');
                return adminClient.investibles.createComment(null, 'comment to fetch', null, true);
            }).then((comment) => {
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'INVESTIBLE_COMMENT_UPDATED'})
                    .then((payload) => comment);
            }).then((comment) => {
                assert(comment.body === 'comment to fetch', 'comment body incorrect');
                assert(comment.is_official === true, 'comment should be official');
                return userClient.investibles.getMarketComments([comment.id]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === createdMarketId, 'market was not set properly on the comment');
                return adminClient.investibles.update(marketInvestibleId, updateFish.name, updateFish.description, updateFish.label_list);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId})
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
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                assert(arrayEquals(investible.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                const marketInfo = fullInvestible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                const current_stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                assert(marketInfo.stage === current_stage.id, 'Instead of ' + marketInfo.stage + ' which is ' + marketInfo.stage_name);
                assert(marketInfo.open_for_investment === true, 'open_for_investment true');
                assert(marketInfo.open_for_refunds === true, 'open_for_refunds true');
                return userClient.markets.updateInvestment(marketInvestibleId, 0, 2000);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'USER_UPDATED', object_id: userId, indirect_object_id: createdMarketId})
                    .then(() => response);
            }).then(() => getMessages(userConfiguration)
            ).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(invalidVoting, 'Should be not voted after removing investment');
                const repliedComment = messages.find(obj => {
                    return obj.type_object_id === 'INVESTIBLE_COMMENT_' + marketInvestibleId;
                });
                assert(repliedComment.level === 'YELLOW', 'replied to your comment is yellow');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};


