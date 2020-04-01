import assert from 'assert'
import {getSummariesInfo, loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        market_type: 'PLANNING',
    };
    describe('#do market investible tests', () => {
        it('create investible and deletion without error', async() => {
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let accountClient;
            let createdMarketId;
            let clonedMarketId;
            let marketInvestibleId;
            let otherUserId;
            let otherAccountId;
            let globalSummariesClient;
            let globalIdToken;
            let linkedMarketId;
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market.id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.investibles.create('salmon', 'good on bagels');
            }).then((investible) => {
                marketInvestibleId = investible.investible.id;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: createdMarketId});
            }).then(() => getSummariesInfo(adminConfiguration)).then((summariesInfo) => {
                const {summariesClient, idToken} = summariesInfo;
                globalSummariesClient = summariesClient;
                globalIdToken = idToken;
                return summariesClient.versions(idToken);
            }).then((versions) => {
                let marketVersion = 0;
                let investibleVersion = 0;
                let marketInvestibleVersion = 0;
                let marketCapabilityVersion = 0;
                let marketInvestibleSecondaryId = null;
                let investibleIdOne = null;
                let foundAnythingElse = false;
                const { global_version: globalVersion, signatures } = versions;
                signatures.forEach((signature) => {
                    const {market_id: marketId, signatures: marketSignatures} = signature;
                    if (marketId === createdMarketId) {
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
                                else {
                                    foundAnythingElse = true;
                                }
                            })
                        })
                    }
                });
                assert(marketVersion === 1 && investibleVersion === 1 && marketInvestibleVersion === 1 && marketCapabilityVersion === 1, 'signature versions incorrect');
                assert(!foundAnythingElse, 'unchanged object present');
                assert(marketInvestibleSecondaryId === marketInvestibleId, 'object id one is the market info id and secondary the investible');
                assert(investibleIdOne === marketInvestibleId, 'object id one is the investible');
                return globalSummariesClient.versions(globalIdToken, globalVersion);
            }).then((versions) => {
                const { global_version: globalVersion, signatures } = versions;
                assert(!globalVersion, 'None when nothing changed');
                assert(signatures.length === 0, 'Empty when nothing changed');
                return globalSummariesClient.notifications(globalIdToken);
            }).then((notifications) => {
                let foundNotificationType = false;
                let foundAppVersionType = false;
                notifications.forEach((notification) => {marketInvestibleId
                    const { type_object_id: typeObjectId } = notification;
                    if (typeObjectId.startsWith('notification')) {
                        foundNotificationType = true;
                    }
                    if (typeObjectId === 'app_version') {
                        foundAppVersionType = true;
                    }
                });
                assert(foundNotificationType && foundAppVersionType, 'notifications incomplete');
                // Add user to this market and get user_id so can user below to test add user api
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                // Add user to this market and get user_id so can user below to test add user api
                return client.users.get();
            }).then((user) => {
                otherUserId = user.id;
                otherAccountId = user.account_id;
                return accountClient.markets.createMarket(marketOptions);
            }).then((response) => {
                clonedMarketId = response.market.id;
                return adminClient.investibles.copy(marketInvestibleId, clonedMarketId);
            }).then(() => {
                return loginUserToMarket(adminConfiguration, clonedMarketId);
            }).then((client) => {
                adminClient = client;
                // Add user to the market
                return adminClient.users.addUsers([{user_id: otherUserId, account_id: otherAccountId}]);
            }).then((response) => {
                assert(response.success_message === 'Capabilities added', 'Add not successful');
                return adminClient.investibles.share(marketInvestibleId);
            }).then(() => {
                // Verify user successfully getting push as a result of addUsers api
                return userConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible', object_id: clonedMarketId});
            }).then(() => {
                marketOptions.parent_market_id = clonedMarketId;
                return accountClient.markets.createMarket(marketOptions);
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