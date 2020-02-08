import assert from 'assert'
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 20,
        is_public: true
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
            await promise.then((client) => {
                accountClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.investibles.create('salmon', 'good on bagels');
            }).then((investibleId) => {
                marketInvestibleId = investibleId;
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'investible', object_id: createdMarketId});
            }).then(() => {
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
                clonedMarketId = response.market_id;
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
                return adminClient.markets.updateMarket({name: 'See if can change name without lock', market_stage: 'Inactive'});
            }).then(() => {
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