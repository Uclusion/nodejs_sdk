import assert from 'assert'
import { checkStages } from './commonTestFunctions';
import uclusion from 'uclusion_sdk';
import {CognitoAuthorizer} from 'uclusion_authorizer_sdk';

module.exports = function(adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration) {
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
            let globalCSMMarketInvestibleId;
            let marketInvestibleId;
            let investmentId;
            let globalUserTeamId;
            let listed_team;
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
                return globalClient.users.get(userConfiguration.userId);
            }).then((response) => {
                globalUserTeamId = response.team_id;
                return globalClient.teams.bind(globalUserTeamId);
            }).then((client) => {
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
                // Give async processing time to complete - including the grants to user and team
                // Otherwise the team 450 can't be used an the numbers come out wrong
                return sleep(5000);
            }).then((response) => {
                return globalUserClient.markets.createInvestment(globalUserTeamId, marketInvestibleId, 6001);
            }).then((investment) => {
                investmentId = investment.id;
                assert(investment.quantity === 6001, 'investment quantity should be 6001 instead of ' + investment.quantity);
                // Long sleep to give async processing time to complete for stages
                return sleep(20000);
            }).then((result) => {
                return globalUserClient.markets.listUserInvestments(userConfiguration.userId);
            }).then((result) => {
                return globalClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                return globalClient.teams.followTeam(globalUserTeamId);
            }).then((response) => {
                assert(response.teams_followed.includes(globalUserTeamId), 'Follow team unsuccessful');
                return globalClient.teams.list();
            }).then((teams) => {
                /*
                450	    450	    NEW_TEAM_GRANT	USER
                10450	10000	API_INITIATED	USER
                450	    450	    NEW_TEAM_GRANT	TEAM
                0	    -450	INVESTMENT	    TEAM
                4899	-5551	INVESTMENT	    USER
                */
                listed_team = teams.find(team => { return team.id === globalUserTeamId});
                assert(listed_team.current_user_is_following === true, 'this team current_user_is_following should return true');
                assert(listed_team.quantity_invested === 6001, 'invested quantity should be 6001 instead of ' + listed_team.quantity_invested);
                assert(listed_team.quantity === 4899, 'unspent quantity should be 4899 instead of ' + listed_team.quantity);
                return globalClient.markets.summarizeUserInvestments(listed_team.user_id);
            }).then((result) => {
                let investment = result[0];
                assert(investment.quantity === 6001, 'invested quantity should be 6001 instead of ' + investment.quantity);
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
                assert(stage.name === 'Needs Review', 'investible stage should be Needs Review');
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
