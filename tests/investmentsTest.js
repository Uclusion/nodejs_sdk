import assert from 'assert';
import { arrayEquals } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket, getMessages, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
    const updateFish = {
        name: 'pufferfish',
        description: 'possibly poisonous',
        label_list: ['freshwater', 'spawning']
    };

    describe('#doInvestment', () => {
        it('should create investment without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let parentAdminClient;
            let userClient;
            let userId;
            let userExternalId;
            let adminUserId;
            let adminUserExternalId;
            let createdMarketId;
            let globalInvestibleId;
            let marketInvestibleId;
            let globalStages;
            let parentCommentId;
            let createdMarketInvite;
            await promise.then((client) => {
                const planningOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A'
                };
                return client.markets.createMarket(planningOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                parentAdminClient = client;
                // Add placeholder user to the market so not fully voted when someone votes
                return client.users.inviteUsers(['tuser@uclusion.com']);
            }).then(() => {
                return parentAdminClient.investibles.createComment(undefined, createdMarketId,
                    'Which fish?', null, 'QUESTION', null, null,
                    null, 'DECISION', false, true);
            }).then((response) => {
                createdMarketId = response.market.id;
                globalStages = response.stages;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminUserId = user.id;
                adminUserExternalId = user.external_id;
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return userClient.investibles.create({groupId: createdMarketId, name: 'salmon', description: 'good on bagels'});
            }).then((investible) => {
                globalInvestibleId = investible.investible.id;
                marketInvestibleId = investible.market_infos[0].id;
                console.log('Investible ID is ' + globalInvestibleId);
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                const currentStage = globalStages.find(stage => { return stage.name === 'Created'});
                const stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: currentStage.id,
                    stage_id: stage.id
                };
                return adminClient.investibles.stateChange(globalInvestibleId, stateOptions);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'market_investible', object_id: createdMarketId},
                    {event_type: 'notification', object_id: userExternalId}]);
            }).then(() => {
                return userClient.markets.updateInvestment(globalInvestibleId, 100, 0);
            }).then((investment) => {
                assert(investment.quantity === 100, 'investment quantity should be 100');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification'});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const newVoting = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${globalInvestibleId}_${userId}`;
                });
                assert(newVoting, 'Moderator should be notified of investment');
                return userClient.investibles.createComment(globalInvestibleId, createdMarketId, 'body of my comment', null, 'ISSUE');
            }).then((comment) => {
                parentCommentId = comment.id;
                console.log("Parent comment ID is " + parentCommentId)
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                assert(comment.comment_type === 'ISSUE', 'comment_type incorrect');
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'notification', type_object_id: `UNREAD_COMMENT_${parentCommentId}`}]);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return (obj.type_object_id === 'UNREAD_COMMENT_' + parentCommentId)&&(obj.level === 'RED');
                });
                assert(investibleIssue, 'No investible issue notification');
                return adminClient.investibles.createComment(globalInvestibleId, createdMarketId,'a reply comment', parentCommentId);
            }).then((comment) => {
                assert(comment.reply_id === parentCommentId, 'updated reply_id incorrect');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return obj.type_object_id === 'ISSUE_' + parentCommentId;
                });
                assert(!investibleIssue, 'Issue notification removed by reply');
                const mention = {
                    user_id: adminUserId,
                    external_id: adminUserExternalId,
                };
                return userClient.investibles.updateComment(parentCommentId, 'new body', true,
                    undefined, [mention], undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
            }).then((comment) => {
                console.log('Checking updated comment');
                assert(comment.body === 'new body', 'updated comment body incorrect');
                assert(comment.mentions.length === 1, 'mentions should contain just one person');
                assert(comment.mentions[0].user_id === adminUserId, 'mention should be admin user id');
                assert(comment.resolved, 'updated resolved incorrect');
                assert(comment.children, 'now parent should have children');
                assert(comment.version === 4, `update, reply and resolve should each bump version but ${comment.version}`);
                // Can't do consistent read on GSI so need to wait before do the getMarketComments call
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'notification'}]);
            }).then(() => {
                return getMessages(adminConfiguration);
            }).then((messages) => {
                const investibleIssue = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_' + parentCommentId)&&(obj.level === 'RED')&&(obj.associated_object_id === globalInvestibleId);
                });
                assert(!investibleIssue, 'Investible issue notification should have been deleted');
                const investibleIssueResolved = messages.find(obj => {
                    return (obj.type_object_id === 'ISSUE_RESOLVED_' + parentCommentId)&&(obj.associated_object_id === globalInvestibleId);
                });
                assert(!investibleIssueResolved, 'Resolution should only notify creator');
                const mention = {
                    user_id: userId,
                    external_id: userExternalId,
                }
                return adminClient.investibles.createComment(null, createdMarketId, 'comment to fetch', null,
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
                return userClient.investibles.getMarketComments([{id: comment.id, version: 1}]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === createdMarketId, 'market was not set properly on the comment');
                return adminClient.investibles.lock(globalInvestibleId);
            }).then((fullInvestible) => {
                const { investible } = fullInvestible;
                assert(investible.name === 'salmon', 'lock investible name not passed correctly');
                assert(investible.description === 'good on bagels', 'lock investible description not passed correctly');
                return adminClient.investibles.update(globalInvestibleId, updateFish.name, updateFish.description,
                    updateFish.label_list, undefined, undefined, undefined,
                    undefined, undefined, 1);
            }).then((response) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investible', object_id: createdMarketId})
                  .then(() => response);
            }).then((response) => {
                const { investible } = response;
                assert(investible.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(investible.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                const { label_list } = investible;
                const labels = label_list.map(item => item.label );
                assert(arrayEquals(labels, ['freshwater', 'spawning']), 'update market investible labels not passed on correctly');
                return userClient.markets.getMarketInvestibles(
                    [
                        {investible: {id: globalInvestibleId, version: 1},
                        market_infos: [{id: marketInvestibleId, version: 1}]}
                    ]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const investible = fullInvestible.investible;
                assert(investible.name === 'pufferfish', 'get market investible name incorrect');
                assert(!investible.updated_by_you, 'Market investible should have been updated by the admin not the user');
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                const { label_list } = investible;
                const labels = label_list.map(item => item.label );
                assert(arrayEquals(labels, ['freshwater', 'spawning']), 'update market investible labels not passed on correctly');
                const marketInfo = fullInvestible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                const current_stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                assert(marketInfo.stage === current_stage.id, 'Instead of ' + marketInfo.stage + ' which is ' + marketInfo.stage_name);
                assert(marketInfo.open_for_investment === true, 'open_for_investment true');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const invalidVoting = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + createdMarketId;
                });
                assert(invalidVoting, 'Should be not voted after investment removed by opening issue');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};


