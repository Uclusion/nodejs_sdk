import assert from 'assert'
import {
    getSummariesInfo,
    loginUserToAccountAndGetToken,
    loginUserToMarket,
    loginUserToMarketInvite
} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name: 'Default plan',
        description: 'This is default plan.',
        market_type: 'PLANNING',
    };
    const dialogMarketOptions = {
        name: 'Default',
        description: 'This is default.',
        market_type: 'DECISION',
        expiration_minutes: 20,
    };
    const inlineMarketOptions = {
        name: 'NA',
        description: 'NA',
        market_type: 'DECISION',
        is_inline: true,
    };
    describe('#do market investible tests', () => {
        it('create investible and deletion without error', async() => {
            let promise = loginUserToAccountAndGetToken(adminConfiguration);
            let adminClient;
            let accountClient;
            let createdMarketId;
            let clonedMarketId;
            let marketInvestibleId;
            let otherUserId;
            let otherAccountId;
            let globalSummariesClient;
            let linkedMarketId;
            let inlineMarketId;
            let createdMarketInvite;
            let globalGlobalVersion;
            let globalAccountToken;
            await promise.then((response) => {
                const { accountToken, client } = response;
                accountClient = client;
                globalAccountToken = accountToken;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                createdMarketInvite = response.market.invite_capability;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return client.users.get();
            }).then((user) => {
                return adminClient.investibles.create('salmon', 'good on bagels', null, [user.id]);
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => getSummariesInfo(adminConfiguration)).then((summariesInfo) => {
                const {summariesClient} = summariesInfo;
                globalSummariesClient = summariesClient;
                return summariesClient.idList(globalAccountToken).then((result) => {
                    const { foreground, background, global_version: globalVersion } = result;
                    globalGlobalVersion = globalVersion;
                    return summariesClient.versions(globalAccountToken, (foreground || []).concat(background || []))
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
                                else if (aType === 'market_capability') {
                                    marketCapabilityVersion = version;
                                }
                                else if (aType === 'stage') {
                                    stageVersion = version;
                                }
                                else {
                                    foundAnythingElse = true;
                                }
                            })
                        })
                    }
                });
                assert(marketVersion === 1 && investibleVersion === 1 && marketInvestibleVersion === 1
                    && marketCapabilityVersion === 1 && stageVersion === 1, `incorrect version ${marketVersion} ${investibleVersion} ${marketInvestibleVersion} ${marketCapabilityVersion} ${stageVersion}`);
                assert(!foundAnythingElse, 'unchanged object present');
                assert(marketInvestibleSecondaryId === marketInvestibleId, 'object id one is the market info id and secondary the investible');
                assert(investibleIdOne === marketInvestibleId, 'object id one is the investible');
                return globalSummariesClient.idList(globalAccountToken, globalGlobalVersion);
            }).then((versions) => {
                const { global_version: globalVersion, foreground, background } = versions;
                assert(!globalVersion, 'None when nothing changed');
                assert(foreground.length === 0, 'Empty when nothing changed');
                assert(background.length === 0, 'Also empty when nothing changed');
                return globalSummariesClient.notifications(globalAccountToken);
            }).then((notifications) => {
                let foundNotificationType = false;
                let foundAppVersionType = false;
                notifications.forEach((notification) => {
                    const {type_object_id: typeObjectId} = notification;
                    if (typeObjectId.startsWith('notification')) {
                        foundNotificationType = true;
                    }
                    if (typeObjectId === 'app_version') {
                        foundAppVersionType = true;
                    }
                });
                assert(foundNotificationType && foundAppVersionType, 'notifications incomplete');
                inlineMarketOptions.parent_market_id = createdMarketId;
                inlineMarketOptions.parent_investible_id = marketInvestibleId;
                return accountClient.markets.createMarket(inlineMarketOptions);
            }).then((response) => {
                inlineMarketId = response.market.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => {
                return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                const fullInvestible = investibles[0];
                const marketInfo = fullInvestible.market_infos.find(info => {
                    return info.market_id === createdMarketId;
                });
                assert(marketInfo.inline_market_id === inlineMarketId, 'inline correctly linked');
                // Add user to this market and get user_id so can user below to test add user api
                return loginUserToMarketInvite(userConfiguration, createdMarketInvite);
            }).then((client) => {
                // Add user to this market and get user_id so can user below to test add user api
                return client.users.get();
            }).then((user) => {
                otherUserId = user.id;
                otherAccountId = user.account_id;
                return accountClient.markets.createMarket(dialogMarketOptions);
            }).then((response) => {
                clonedMarketId = response.market.id;
                return adminClient.investibles.copy(marketInvestibleId, clonedMarketId);
            }).then(() => {
                return loginUserToMarket(adminConfiguration, clonedMarketId);
            }).then((client) => {
                adminClient = client;
                // Add user to the market
                return adminClient.users.addUsers([{user_id: otherUserId, account_id: otherAccountId}]);
            }).then((presences) => {
                const { id } = presences[0];
                assert(id, 'Add not successful');
                return adminClient.investibles.share(marketInvestibleId);
            }).then(() => {
                // Verify user successfully getting push as a result of addUsers api
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: clonedMarketId});
            }).then(() => {
                dialogMarketOptions.parent_market_id = clonedMarketId;
                return accountClient.markets.createMarket(dialogMarketOptions);
            }).then((response) => {
                linkedMarketId = response.market.id;
                assert(response.market.parent_market_id === clonedMarketId, 'Link not successful');
                // Wait for children of cloned market to be updated
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: clonedMarketId});
            }).then(() => {
                return adminClient.markets.updateMarket({name: 'See if can change name without lock', market_stage: 'Inactive'});
            }).then((market) => {
                const { children } = market;
                assert(children[0] === linkedMarketId, 'Linked children wrong');
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: clonedMarketId});
            }).then(() => {
                return adminClient.investibles.create('salmon', 'good on bagels')
                    .catch(function(error) {
                        assert(error.status === 403, 'Wrong error = ' + JSON.stringify(error));
                        return 'Market inactive';
                    });
            }).then((response) => {
                assert(response === 'Market inactive', 'Wrong response = ' + response);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(240000);
    });
};