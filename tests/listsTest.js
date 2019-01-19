import assert from 'assert'
import {uclusion} from "../src/uclusion";

module.exports = function(adminConfiguration, userConfiguration, userId) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market'
    };
    describe('#doList', () => {
        it('should list without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let userPromise = uclusion.constructClient(userConfiguration);
            let globalClient;
            let globalUserClient;
            let globalMarketId;
            let globalInvestibleId;
            let globalCSMInvestibleId;
            let marketInvestibleId;
            let investmentId;
            let globalUserTeamId;
            await userPromise.then((client) => {
                globalUserClient = client;
                return promise;
            }).then((client) => {
                globalClient = client;
                return client.markets.createMarket(butterOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return globalUserClient.investibles.create('butter', 'good on bagels');
            }).then((response) => {
                globalInvestibleId = response.id;
                return globalClient.investibles.create('peanut butter', 'good with jelly');
            }).then((response) => {
                globalCSMInvestibleId = response.id;
                return globalClient.investibles.createCategory('sandwich', globalMarketId);
            }).then((response) => {
                return globalClient.investibles.bindToMarket(globalCSMInvestibleId, globalMarketId, ['sandwich']);
            }).then((investible) => {
                assert(investible.name === 'peanut butter', 'name not passed on correctly');
                assert(investible.quantity === 0, 'market investible quantity incorrect');
                return globalUserClient.users.get(userId);
            }).then((response) => {
                globalUserTeamId = response.team_id;
                return globalClient.teams.bind(globalUserTeamId, globalMarketId);
            }).then((response) => {
                return globalClient.users.grant(userId, globalMarketId, 10000);
            }).then((response) => {
                return globalClient.investibles.createCategory('salted', globalMarketId);
            }).then((response) => {
                return globalClient.investibles.createCategory('unsalted', globalMarketId);
            }).then((response) => {
                return globalUserClient.markets.investAndBind(globalMarketId, globalUserTeamId, globalInvestibleId, 6001, ['salted', 'unsalted']);
            }).then((response) => {
                let investment = response.investment;
                investmentId = investment.id;
                marketInvestibleId = investment.investible_id;
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                return globalUserClient.investibles.listComments(marketInvestibleId, 100);
            }).then((response) => {
                return globalUserClient.markets.listCategories(globalMarketId);
            }).then((result) => {
                return globalUserClient.investibles.listTemplates(100);
            }).then((result) => {
                return globalUserClient.markets.listInvestiblePresences(globalMarketId);
            }).then((response) => {
                // Long sleep to give stages async processing time to complete
                return sleep(15000);
            }).then((result) => {
                return globalUserClient.markets.listTrending(globalMarketId, '2015-01-22T03:23:26Z');
            }).then((result) => {
                return globalUserClient.markets.listUserInvestments(globalMarketId, userId, 20);
            }).then((result) => {
                return globalUserClient.markets.listInvestibles(globalMarketId, 'hello', 5, 20);
            }).then((result) => {
                return globalUserClient.markets.listCategoriesInvestibles(globalMarketId, 'fish', 5, 20);
            }).then((response) => {
                return globalUserClient.markets.getMarketInvestible(globalMarketId, marketInvestibleId);
            }).then((investible) => {
                assert(investible.stage === 'NEEDS_REVIEW', 'investible stage should be NEEDS_REVIEW');
                assert(investible.next_stage === 'REVIEW_COMPLETE', 'investible next stage should be REVIEW_COMPLETE');
                assert(investible.next_stage_threshold === 0, 'investible next stage threshold should be 0');
                return globalUserClient.investibles.delete(globalInvestibleId);
            }).then((response) => {
                //console.log('marketInvestibleId '+marketInvestibleId);
                return globalClient.investibles.delete(marketInvestibleId);
            }).then((response) => {
                return globalClient.investibles.delete(globalCSMInvestibleId);
            }).then((response) => {
                return globalClient.markets.deleteMarket(globalMarketId);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
};


function sleep(ms){
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}
