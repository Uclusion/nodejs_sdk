import assert from 'assert'
import { checkStages } from './commonTestFunctions';
import uclusion from 'uclusion_sdk';
import {CognitoAuthorizer} from 'uclusion_authorizer_sdk';

module.exports = function(adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market',
        expiration_minutes: 10,
    };
    const adminExpectedStageNames = [ 'Unreviewed', 'Needs Review', 'Needs Investment', 'Under Consideration', 'Complete'];

    describe('#doList', () => {
        it('should list without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalUserClient;
            let globalCSMMarketInvestibleId;
            let marketInvestibleId;
            let globalStages;
            let globalMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(butterOptions);
            }).then((response) => {
                const configuration = {...adminConfiguration};
                const adminAuthorizerConfig = {...adminAuthorizerConfiguration};
                globalMarketId = response.market_id;
                adminAuthorizerConfig.marketId = response.market_id;
                configuration.authorizer = new CognitoAuthorizer(adminAuthorizerConfig);
                return uclusion.constructClient(configuration);
            }).then((client) => {
                globalClient = client;
                const userConfig = {...userConfiguration};
                const userAuthorizerConfig = {...userAuthorizerConfiguration};
                userAuthorizerConfig.marketId = globalMarketId;
                userConfig.authorizer = new CognitoAuthorizer(userAuthorizerConfig);
                return uclusion.constructClient(userConfig);
            }).then((client) => {
                globalUserClient = client;
                return globalClient.markets.listStages();
            }).then((stageList) => {
                checkStages(adminExpectedStageNames, stageList);
                return globalUserClient.investibles.create('butter', 'good on bagels');
            }).then((response) => {
                marketInvestibleId = response.id;
                return globalClient.investibles.create('peanut butter', 'good with jelly');
            }).then((investible) => {
                globalCSMMarketInvestibleId = investible.id;
                assert(investible.name === 'peanut butter', 'name not passed on correctly');
                assert(investible.quantity === 0, 'market investible quantity incorrect');
                return globalClient.users.grant(userConfiguration.userId, 10000);
            }).then((response) => {
                // Give async processing time to complete - including the grants to user
                return sleep(5000);
            }).then((response) => {
                return globalUserClient.markets.updateInvestment(marketInvestibleId, 6001, 0);
            }).then((investment) => {
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                // Long sleep to give async processing time to complete for stages
                return sleep(20000);
            }).then((result) => {
                return globalClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                return globalUserClient.markets.listInvestibles();
            }).then((result) => {
                let investibles = result.investibles;
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.id === marketInvestibleId, 'should find the investible');
                return globalUserClient.markets.getMarketInvestibles([marketInvestibleId, globalCSMMarketInvestibleId]);
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
                return globalClient.markets.deleteMarket();
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
