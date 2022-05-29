import assert from 'assert'
import {
    getSummariesInfo,
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
            let globalSummariesClient;
            let inlineMarketId;
            let createdMarketInvite;
            let globalAccountToken;
            let createdCommentId;
            await promise.then((response) => {
                const { accountToken, client } = response;
                accountClient = client;
                globalAccountToken = accountToken;
                const marketOptions = {
                    market_type: 'PLANNING',
                };
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return client.users.get();
            }).then((user) => {
                return adminClient.investibles.create({name: 'salmon', description: 'good on bagels',
                    assignments: [user.id]});
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.investibles.createComment(marketInvestibleId, 'body of my comment', null, 'QUESTION');
            }).then((comment) => {
                createdCommentId = comment.id;
                // Since admin client created the comment we are not expecting a notification here
                return adminConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'comment', object_id: createdMarketId},
                    {event_type: 'market_investible', object_id: createdMarketId}]);
            }).then(() => getSummariesInfo(adminConfiguration)).then((summariesInfo) => {
                const {summariesClient} = summariesInfo;
                globalSummariesClient = summariesClient;
                return summariesClient.idList(globalAccountToken).then((audits) => {
                    const allMarkets = audits.map((audit) => audit.id);
                    return summariesClient.versions(globalAccountToken, allMarkets)
                });
            }).then((versions) => {
                let marketVersion = 0;
                let investibleVersion = 0;
                let marketInvestibleVersion = 0;
                let marketCapabilityVersion = 0;
                let stageVersion = 0;
                let marketInvestibleSecondaryId = null;
                let investibleIdOne = null;
                let foundAnythingElse = false;
                let commentId = null;
                let commentVersion = 0;
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
                                else if (aType === 'stage') {
                                    stageVersion = version;
                                }
                                else if (aType === 'group') {
                                    //TODO finish
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
                // marketCapabilityVersion is 3 because subscribed to investible and question comment
                assert(marketVersion === 1 && investibleVersion === 1 && marketInvestibleVersion === 2
                    && marketCapabilityVersion === 3 && stageVersion === 1 && commentVersion === 1,
                    `incorrect version ${marketVersion} ${investibleVersion} ${marketInvestibleVersion} ${marketCapabilityVersion} ${stageVersion} ${commentVersion}`);
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
                return adminClient.investibles.getMarketComments([createdCommentId]);
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
                };
                return accountClient.markets.createMarket(marketOptions);
            }).then((response) => {
                secondMarketId = response.market.id;
                return loginUserToMarketInvite(adminConfiguration, response.market.invite_capability);
            }).then((client) => {
                adminClient = client;
                // Add user to the market
                return adminClient.users.addUsers([{external_id: otherUserExternalId, account_id: otherAccountId}]);
            }).then((presences) => {
                const { id } = presences[0];
                assert(id, 'Add not successful');
                return adminClient.investibles.share(marketInvestibleId);
            }).then(() => {
                // Verify user successfully getting push as a result of addUsers api
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible',
                    object_id: secondMarketId});
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};