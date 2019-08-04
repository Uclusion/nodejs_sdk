import assert from 'assert'
import { checkStages } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function(adminConfiguration, userConfiguration) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market',
        expiration_minutes: 10,
    };
    const adminExpectedStageNames = [ 'Unreviewed', 'Needs Review', 'Needs Investment', 'Under Consideration', 'Complete'];

    describe('#doList', () => {
        it('should list without error', async () => {
            let promise = loginUserToAccount(adminConfiguration, adminConfiguration.accountId);
            let adminClient;
            let userClient;
            let userId;
            let globalCSMMarketInvestibleId;
            let marketInvestibleId;
            let globalStages;
            let createdMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(butterOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                userClient = client;
                return userClient.users.get();
            }).then((user) => {
                userId = user.id;
                return adminClient.markets.listStages();
            }).then((stageList) => {
                checkStages(adminExpectedStageNames, stageList);
                return userClient.investibles.create('butter', 'good on bagels');
            }).then((response) => {
                marketInvestibleId = response.id;
                return adminClient.investibles.create('peanut butter', 'good with jelly');
            }).then((investible) => {
                globalCSMMarketInvestibleId = investible.id;
                assert(investible.name === 'peanut butter', 'name not passed on correctly');
                assert(investible.quantity === 0, 'market investible quantity incorrect');
                return adminClient.users.grant(userId, 10000);
            }).then((response) => {
                // Give async processing time to complete - including the grants to user
                return sleep(5000);
            }).then((response) => {
                return userClient.markets.updateInvestment(marketInvestibleId, 6001, 0);
            }).then((investment) => {
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                // Long sleep to give async processing time to complete for stages
                return sleep(20000);
            }).then((result) => {
                return adminClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                return userClient.markets.listInvestibles();
            }).then((result) => {
                let investibles = result.investibles;
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.id === marketInvestibleId, 'should find the investible');
                return userClient.markets.getMarketInvestibles([marketInvestibleId, globalCSMMarketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                let stage = globalStages.find(stage => { return stage.id === investible.stage});
                assert(stage.name === 'Unreviewed', 'investible stage should be Unreviewed');
                investible = investibles.find(obj => {
                    return obj.id === globalCSMMarketInvestibleId;
                });
                stage = globalStages.find(stage => { return stage.id === investible.stage});
                assert(stage.name === 'Unreviewed', 'investible stage should be Unreviewed');
                return adminClient.markets.deleteMarket();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(120000);
    });
};


function sleep(ms){
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}
