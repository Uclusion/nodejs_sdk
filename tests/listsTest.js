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
            let globalCSMMarketInvestibleId;
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
                globalCSMMarketInvestibleId = investible.id;
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
                return globalUserClient.markets.listCategories(globalMarketId);
            }).then((result) => {
                return globalUserClient.investibles.listTemplates(100);
            }).then((result) => {
                return globalUserClient.markets.listInvestiblePresences(globalMarketId);
            }).then((response) => {
                // Long sleep to give async processing time to complete
                return sleep(20000);
            }).then((result) => {
                return globalUserClient.markets.listUserInvestments(globalMarketId, userId, 20);
            }).then((result) => {
                return globalClient.teams.list(globalMarketId);
            }).then((result) => {
                let listed_team = result[0];
                assert(listed_team.quantity_invested === 6001, 'invested quantity should be 6001 instead of ' + listed_team.quantity_invested);
                assert(listed_team.quantity === 4449, 'unspent quantity should be 4449 instead of ' + listed_team.quantity);
                return globalClient.teams.investments(globalUserTeamId, globalMarketId);
            }).then((result) => {
                let investment = result[marketInvestibleId];
                assert(investment.quantity === 6001, 'invested quantity should be 6001 instead of ' + investment.quantity);
                return globalUserClient.markets.listInvestibles(globalMarketId);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.id === marketInvestibleId, 'should find the investible');
                return globalUserClient.markets.getMarketInvestibles(globalMarketId, [marketInvestibleId, globalCSMMarketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.stage === 'NEEDS_REVIEW', 'investible stage should be NEEDS_REVIEW');
                assert(investible.next_stage === 'REVIEW_COMPLETE', 'investible next stage should be REVIEW_COMPLETE');
                assert(investible.next_stage_threshold === 0, 'investible next stage threshold should be 0');
                investible = investibles.find(obj => {
                    return obj.id === globalCSMMarketInvestibleId;
                });
                assert(investible.stage === 'BOUND', 'investible stage should be BOUND');
                return globalUserClient.investibles.delete(globalInvestibleId);
            }).then((response) => {
                //console.log('marketInvestibleId '+marketInvestibleId);
                return globalClient.investibles.delete(marketInvestibleId);
            }).then((response) => {
                assert(response.success_message === 'Investible deleted', 'Investible delete not successful');
                return globalClient.investibles.delete(globalCSMInvestibleId);
            }).then((response) => {
                assert(response.success_message === 'Investible deleted', 'Investible delete not successful');
                return globalClient.investibles.delete(globalCSMMarketInvestibleId);
            }).then((response) => {
                assert(response.success_message === 'Investible deleted', 'Investible delete not successful');
                return globalClient.investibles.deleteCategory('sandwich', globalMarketId);
            }).then((response) => {
                assert(response.success_message === 'Category deleted', 'Category delete not successful');
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
