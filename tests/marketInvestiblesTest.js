import assert from 'assert'
import {
    loginUserToAccountAndGetToken,
    loginUserToMarket,
    loginUserToMarketInvite
} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    describe('#do market investible tests', () => {
        it('create investible and deletion without error', async() => {
            let promise = loginUserToAccountAndGetToken(adminConfiguration);
            let adminClient;
            let accountClient;
            let createdMarketId;
            let secondMarketId;
            let marketInvestibleId;
            let otherAccountId;
            let otherUserExternalId;
            let inlineMarketId;
            let createdMarketInvite;
            let globalAccountToken;
            let createdCommentId;
            let adminUserId;
            await promise.then((response) => {
                const { accountToken, client } = response;
                accountClient = client;
                globalAccountToken = accountToken;
                const marketOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A'
                };
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                adminUserId = response.presence.id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return client.users.get();
            }).then((user) => {
                return adminClient.investibles.create({groupId: createdMarketId, name: 'salmon', description: 'good on bagels',
                    assignments: [user.id]});
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.createComment(marketInvestibleId, createdMarketId, 'body of my comment', null, 'QUESTION');
            }).then((comment) => {
                createdCommentId = comment.id;
                // Since admin client created the comment we are not expecting a notification here
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'market_investible', object_id: createdMarketId}]);
            }).then(() => {
                return adminClient.summaries.idList(globalAccountToken).then((audits) => {
                    const allMarkets = audits.map((audit) => audit.id);
                    return adminClient.summaries.versions(globalAccountToken, allMarkets)
                });
            }).then((versions) => {
                let marketVersion = 0;
                let investibleVersion = 0;
                let marketInvestibleVersion = 0;
                let marketCapabilityVersion = 0;
                let stageVersion = 0;
                let addressedVersion = 0;
                let marketInvestibleSecondaryId = null;
                let investibleIdOne = null;
                let foundAnythingElse = false;
                let commentId = null;
                let commentVersion = 0;
                let groupVersion = 0;
                let groupCapabilityVersion = 0;
                const { signatures } = versions;
                signatures.forEach((signature) => {
                    const {market_id: marketId, signatures: marketSignatures} = signature;
                    if (marketId === createdMarketId) {
                        console.log(`For ${marketId} have ${JSON.stringify(marketSignatures)}`);
                        marketSignatures.forEach((marketSignature) => {
                            const {type: aType, object_versions: objectVersions} = marketSignature;
                            objectVersions.forEach((objectVersion) => {
                                const {object_id_one: objectId, object_id_two: objectIdSecondary, version} = objectVersion;
                                if (aType === 'market') {
                                    marketVersion = version;
                                }
                                else if (aType === 'investible') {
                                    investibleIdOne = objectId;
                                    investibleVersion = version;
                                }
                                else if (aType === 'market_investible') {
                                    marketInvestibleVersion = version;
                                    marketInvestibleSecondaryId = objectIdSecondary;
                                }
                                else if (aType === 'comment') {
                                    commentVersion = version;
                                    commentId = objectId;
                                }
                                else if (aType === 'market_capability') {
                                    marketCapabilityVersion = version;
                                }
                                else if (aType === 'group_capability') {
                                    groupCapabilityVersion = version;
                                }
                                else if (aType === 'stage') {
                                    stageVersion = version;
                                }
                                else if (aType === 'group') {
                                    // A everyone public group created with the market
                                    groupVersion = version;
                                }
                                else if (aType === 'addressed') {
                                    //Added a comment but was already in group so should not get here
                                    addressedVersion = version;
                                    assert(objectIdSecondary === adminUserId, 'Admin added a comment');
                                }
                                else {
                                    console.log(`Found unexpected type ${aType}`);
                                    foundAnythingElse = true;
                                }
                            })
                        })
                    }
                });
                // marketInvestibleVersion is 2 because creating the Question moved it to Requires Input
                // groupVersion is 1 because group code updates are not saved as object versions
                assert(marketVersion === 1 && investibleVersion === 1 && marketInvestibleVersion === 2
                    && marketCapabilityVersion === 1 && stageVersion === 1 && commentVersion === 1 &&
                    addressedVersion === 0 && groupVersion === 1 && groupCapabilityVersion === 1,
                    `incorrect version ${marketVersion} ${investibleVersion} ${marketInvestibleVersion} ${marketCapabilityVersion} ${stageVersion} ${commentVersion} ${addressedVersion} ${groupVersion} ${groupCapabilityVersion}`);
                assert(!foundAnythingElse, 'unchanged object present');
                assert(marketInvestibleSecondaryId === marketInvestibleId, 'object id one is the market info id and secondary the investible');
                assert(investibleIdOne === marketInvestibleId, 'object id one is the investible');
                assert(commentId === createdCommentId, 'object id is created comment');
                const inlineMarketOptions = {
                    market_type: 'DECISION',
                    parent_comment_id: createdCommentId
                };
                return accountClient.markets.createMarket(inlineMarketOptions);
            }).then((response) => {
                inlineMarketId = response.market.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'comment', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.getMarketComments([{id: createdCommentId, version: 1}]);
            }).then((comments) => {
                const comment = comments[0];
                assert(comment.inline_market_id === inlineMarketId, 'inline correctly linked');
                // Add user to this market and get user_id so can user below to test add user api
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                // Add user to this market and get user_id so can user below to test add user api
                return client.users.get();
            }).then((user) => {
                otherAccountId = user.account_id;
                otherUserExternalId = user.external_id;
                const marketOptions = {
                    market_type: 'PLANNING',
                    name: 'Company A'
                };
                return accountClient.markets.createMarket(marketOptions);
            }).then((response) => {
                secondMarketId = response.market.id;
                return loginUserToMarketInvite(adminConfiguration, response.market.invite_capability);
            }).then((client) => {
                adminClient = client;
                // Add user to the market
                return adminClient.users.addUsers([{external_id: otherUserExternalId,
                    account_id: otherAccountId}]);
            }).then((presences) => {
                const { id } = presences[0];
                assert(id, 'Add not successful');
                return adminClient.investibles.create({groupId: createdMarketId, name: 'A job',
                    description: 'To verify push.', todos: ['<p>My thing one.</p>','<p>My thing two.</p>']});
            }).then((result) => {
                const { investible, todos } = result;
                assert(investible, 'Investible missing');
                assert(todos.length === 2, 'Todos wrong size');
                const todoOne = todos.find((todo) => todo.body === '<p>My thing one.</p>');
                assert(todoOne, 'Matching todo missing');
                // Verify user getting push from admin client creating investible after user added from addUsers api
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible',
                    object_id: secondMarketId});
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};