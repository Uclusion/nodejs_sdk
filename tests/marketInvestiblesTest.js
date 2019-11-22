import assert from 'assert'
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        expiration_minutes: 20,
        new_user_grant: 313,
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
            let copiedInvestibleId;
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
                return adminClient.markets.updateMarket({expiration_minutes: 30});
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: createdMarketId});
            }).then((response) => {
                return accountClient.markets.createMarket(marketOptions);
            }).then((response) => {
                clonedMarketId = response.market_id;
                return adminClient.investibles.copy(marketInvestibleId, clonedMarketId);
            }).then((investibleId) => {
                copiedInvestibleId = investibleId;
                return loginUserToMarket(adminConfiguration, clonedMarketId);
            }).then((client) => {
                adminClient = client;
                return adminClient.users.get();
            }).then((user) => {
                adminConfiguration.webSocketRunner.subscribe(user.id, { market_id : clonedMarketId });
                return adminClient.investibles.share(marketInvestibleId);
            }).then(() => {
                return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market', object_id: clonedMarketId});
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