import assert from 'assert';
import {
    loginUserToMarket,
    getMessages,
    loginUserToMarketInvite,
    loginUserToAccountAndGetToken, loginUserToAccount
} from "../src/utils.js";
import _ from "lodash";
import websocket from 'websocket';
import {pollFor} from "./commonTestFunctions.js";
const {version} = websocket;

function hasSummaryObject(versions, marketId, type, objectId) {
    return (versions.signatures || []).some((market) => market.market_id === marketId &&
        (market.signatures || []).some((signature) => signature.type === type &&
            (signature.object_versions || []).some((objectVersion) =>
                objectVersion.object_id_one === objectId)));
}

export default function (adminConfiguration, userConfiguration) {

    describe('#doInlineNotifications', () => {
        it('should do persistent inline notifications without error', async () => {
            let promise = loginUserToAccount(adminConfiguration);
            let accountClient;
            let adminClient;
            let userClient;
            let userId;
            let userExternalId;
            let adminId;
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
            let globalUserAccountToken;
            let globalUserAccountClient;
            await promise.then((client) => {
                accountClient = client;
                const marketOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A'
                };
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarketInvite(adminConfiguration, createdMarketInvite);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminId = user.id;
                return adminClient.investibles.create({groupId: createdMarketId, name: 'A test story', description: 'See if notifications work.',
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
                return userConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_capability', object_id: createdMarketId});
            }).then(() => {
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                userExternalId = user.external_id;
                return adminClient.investibles.createComment(marketInvestibleId, createdMarketId, 'body of my comment',
                    null, 'QUESTION', undefined, undefined, undefined, undefined, undefined, false);
            }).then((comment) => {
                createdCommentId = comment.id;
                return loginUserToAccountAndGetToken(userConfiguration);
            }).then((response) => {
                const { client, accountToken } = response;
                globalUserAccountToken = accountToken;
                globalUserAccountClient = client;
                return client.summaries.versions(globalUserAccountToken, [createdMarketId]);
            }).then((versions) => {
                const { signatures } = versions;
                let foundInvestible = false;
                signatures.forEach((signature) => {
                    const {signatures: marketSignatures} = signature;
                    marketSignatures.forEach((marketSignature) => {
                        const {type: aType, object_versions: objectVersions} = marketSignature;
                        if (!_.isEmpty(objectVersions)) {
                            if (aType === 'investible') {
                                foundInvestible = true;
                            }
                        }
                    });
                });
                const foundCreatedComment = hasSummaryObject(
                    versions, createdMarketId, 'comment', createdCommentId);
                assert(foundInvestible && !foundCreatedComment, 'Comment should still be in draft');
                // The default group has the same id as the market
                return userClient.markets.followGroup(createdMarketId, [{user_id: userId, is_following: true}]);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId, type_object_id: `UNREAD_GROUP_${createdMarketId}`});
            }).then(() => {
                return adminClient.investibles.updateComment(createdCommentId, undefined, undefined,
                    undefined, undefined, undefined, undefined, true);
            }).then((comment) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessages(
                    [{event_type: 'comment', object_id: createdMarketId, object_id_one_two: createdCommentId,
                        version: comment.version},
                        {event_type: 'notification', object_id: userExternalId,
                            type_object_id: `UNREAD_COMMENT_${createdCommentId}`}], 30000);
            }).then(() => {
                return pollFor(
                    () => globalUserAccountClient.summaries.versions(globalUserAccountToken, [createdMarketId]),
                    (versions) => hasSummaryObject(versions, createdMarketId, 'comment', createdCommentId));
            }).then((versions) => {
                const { signatures } = versions;
                let foundInvestible = false;
                signatures.forEach((signature) => {
                    const {signatures: marketSignatures} = signature;
                    marketSignatures.forEach((marketSignature) => {
                        const {type: aType, object_versions: objectVersions} = marketSignature;
                        if (!_.isEmpty(objectVersions)) {
                            if (aType === 'investible') {
                                foundInvestible = true;
                            }
                        }
                    });
                });
                const foundCreatedComment = hasSummaryObject(
                    versions, createdMarketId, 'comment', createdCommentId);
                if (!foundInvestible || !foundCreatedComment) {
                    signatures.forEach((signature) => {
                        console.log(signature);
                    });
                }
                assert(foundInvestible && foundCreatedComment, 'Comment should be out of draft');
                return getMessages(userConfiguration);
            }).then((messages) => {
                const openComment = messages.find(obj => {
                    return obj.type_object_id === 'UNREAD_COMMENT_' + createdCommentId;
                });
                assert(openComment, 'Notification to help with assignees question');
                const inlineMarketOptions = {
                    market_type: 'DECISION',
                    parent_comment_id: createdCommentId
                };
                return accountClient.markets.createMarket(inlineMarketOptions);
            }).then((response) => {
                globalStages = response.stages;
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
                return inlineAdminClient.investibles.create({
                    groupId: createdMarketId,
                    name: 'A test option',
                    description: 'See if inline notifications work.'});
            }).then((investible) => {
                inlineInvestibleId = investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage(
                    {event_type: 'market_investible', object_id: inlineMarketId});
            }).then(() => {
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
                    undefined, [mention], undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
                    undefined, 2);
            }).then((comment) => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment',
                    object_id: createdMarketId, object_id_one_two: createdCommentId,
                    version: comment.version}, 30000);
            }).then(() => {
                return getMessages(userConfiguration);
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(vote && vote.level === 'YELLOW', 'Mention no affect on fully voted level');
                return inlineUserClient.users.dehighlightNotifications([vote.type_object_id]);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId,
                    type_object_id: `NOT_FULLY_VOTED_${inlineMarketId}`}, 30000);
            }).then(() => {
                return pollFor(
                    () => getMessages(userConfiguration),
                    (messages) => {
                        const vote = messages.find((message) =>
                            message.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId);
                        return Boolean(vote && vote.is_highlighted === false);
                    });
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(vote && vote.is_highlighted === false, 'Snoozed is not highlighted');
                return adminClient.users.pokeComment(createdCommentId);
            }).then(() => {
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'notification',
                    object_id: userExternalId,
                    type_object_id: `NOT_FULLY_VOTED_${inlineMarketId}`}, 30000);
            }).then(() => {
                return pollFor(
                    () => getMessages(userConfiguration),
                    (messages) => {
                        const vote = messages.find((message) =>
                            message.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId);
                        return Boolean(vote && vote.is_highlighted);
                    });
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(vote && vote.is_highlighted, 'Poke should restore unread');
                return inlineUserClient.markets.updateAbstain(true);
            }).then(() => {
                return pollFor(
                    () => inlineUserClient.markets.listUsers([{id: inlineUserId, version: 2}]),
                    (users) => {
                        const inlineUser = users.find((user) => user.id === inlineUserId);
                        return Boolean(inlineUser && inlineUser.abstain);
                    });
            }).then((users) => {
                const myInlineUser = users.find(obj => {
                    return obj.id === inlineUserId;
                });
                assert(myInlineUser.abstain, 'Abstain marks the user so');
                return pollFor(
                    () => getMessages(adminConfiguration),
                    (messages) => !messages.some((message) =>
                        message.type_object_id === `UNREAD_VOTE_${marketInvestibleId}_${userId}`));
            }).then((messages) => {
                const voted = messages.find(obj => {
                    return obj.type_object_id === `UNREAD_VOTE_${marketInvestibleId}_${userId}`;
                });
                assert(!voted, 'Abstain removes vote notification');
                return pollFor(
                    () => getMessages(userConfiguration),
                    (fetched) => !fetched.some((message) =>
                        message.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId));
            }).then((messages) => {
                const vote = messages.find(obj => {
                    return obj.type_object_id === 'NOT_FULLY_VOTED_' + inlineMarketId;
                });
                assert(!vote, 'No call to vote after abstain');
                return inlineUserClient.markets.updateInvestment(inlineInvestibleId, 100,
                    0);
            }).then(() => {
                return pollFor(
                    () => inlineUserClient.markets.listUsers([{id: inlineUserId, version: 3}]),
                    (users) => {
                        const inlineUser = users.find((user) => user.id === inlineUserId);
                        return Boolean(inlineUser && !inlineUser.abstain);
                    });
            }).then((users) => {
                const myInlineUser = users.find(obj => {
                    return obj.id === inlineUserId;
                });
                assert(!myInlineUser.abstain, 'Investing marks the user not abstained');
            }).catch(function (error) {
                console.log(error);
                throw error;
            });
        }).timeout(480000);
    });
};
