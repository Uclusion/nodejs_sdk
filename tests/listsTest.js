import assert from 'assert'
import { checkStages } from "./common_functions";
import {uclusion} from "../src/uclusion";

module.exports = function(adminConfiguration, userConfiguration) {
    const butterOptions = {
        name : 'butter',
        description: 'this is a butter market'
    };
    const adminExpectedStageNames = [ 'Unreviewed', 'Needs Review', 'Needs Investment', 'Under Consideration', 'Complete'];

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
            let listed_team;
            let globalStages;
            await userPromise.then((client) => {
                globalUserClient = client;
                return promise;
            }).then((client) => {
                globalClient = client;
                return client.markets.createMarket(butterOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return globalClient.markets.listStages(globalMarketId);
            }).then((stageList) => {
                checkStages(adminExpectedStageNames, stageList);
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
                return globalUserClient.users.get(userConfiguration.userId);
            }).then((response) => {
                globalUserTeamId = response.team_id;
                return globalClient.teams.bind(globalUserTeamId, globalMarketId);
            }).then((response) => {
                return globalClient.users.grant(userConfiguration.userId, globalMarketId, 10000);
            }).then((response) => {
                return globalClient.investibles.createCategory('salted', globalMarketId);
            }).then((response) => {
                return globalClient.investibles.createCategory('unsalted', globalMarketId);
            }).then((response) => {
                // Give async processing time to complete - including the grants to user and team
                // Otherwise the team 450 can't be used an the numbers come out wrong
                return sleep(5000);
            }).then((response) => {
                return globalUserClient.markets.investAndBind(globalMarketId, globalUserTeamId, globalInvestibleId, 6001, ['salted', 'unsalted']);
            }).then((response) => {
                let investment = response.investment;
                investmentId = investment.id;
                marketInvestibleId = investment.investible_id;
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                return globalUserClient.investibles.listTemplates(100);
            }).then((response) => {
                // Long sleep to give async processing time to complete for stages
                return sleep(20000);
            }).then((result) => {
                return globalUserClient.markets.listUserInvestments(globalMarketId, userConfiguration.userId, 10000);
            }).then((result) => {
                return globalClient.markets.listStages(globalMarketId);
            }).then((stages) => {
                globalStages = stages;
                return globalClient.teams.followTeam(globalUserTeamId, globalMarketId);
            }).then((response) => {
                assert(response.teams_followed.includes(globalUserTeamId), 'Follow team unsuccessful');
                return globalClient.teams.list(globalMarketId);
            }).then((result) => {
                /*
                450	    450	    NEW_TEAM_GRANT	USER
                10450	10000	API_INITIATED	USER
                450	    450	    NEW_TEAM_GRANT	TEAM
                0	    -450	INVESTMENT	    TEAM
                4899	-5551	INVESTMENT	    USER
                10900	6001	ROI	            USER
                */
                listed_team = result[0];
                assert(listed_team.current_user_is_following === true, 'this team current_user_is_following should return true');
                assert(listed_team.quantity_invested === 6001, 'invested quantity should be 6001 instead of ' + listed_team.quantity_invested);
                assert(listed_team.quantity === 10900, 'unspent quantity should be 10900 instead of ' + listed_team.quantity);
                return globalClient.markets.listUserInvestments(globalMarketId, listed_team.user_id, 10000);
            }).then((result) => {
                let investment = result[0];
                assert(investment.quantity === 6001, 'invested quantity should be 6001 instead of ' + investment.quantity);
                return globalUserClient.markets.listInvestibles(globalMarketId);
            }).then((result) => {
                let categories = result.categories;
                assert(categories.length === 3, 'should be 3 categories instead of ' + categories.length);
                categories.map((category) => {
                    assert(category.investibles_in === 1, 'investibles_in should be 1 instead of ' + category.investibles_in)
                });
                let investibles = result.investibles;
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                assert(investible.id === marketInvestibleId, 'should find the investible');
                return globalUserClient.markets.getMarketInvestibles(globalMarketId, [marketInvestibleId, globalCSMMarketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles.find(obj => {
                    return obj.id === marketInvestibleId;
                });
                let stage = globalStages.find(stage => { return stage.id === investible.stage});
                assert(stage.name === 'Needs Review', 'investible stage should be Needs Review');
                investible = investibles.find(obj => {
                    return obj.id === globalCSMMarketInvestibleId;
                });
                stage = globalStages.find(stage => { return stage.id === investible.stage});
                assert(stage.name === 'Unreviewed', 'investible stage should be Unreviewed');
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
        }).timeout(120000);
    });
};


function sleep(ms){
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}
