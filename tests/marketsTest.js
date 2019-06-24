import assert from 'assert'
import uclusion from 'uclusion_sdk';
import {checkStages, verifyStage} from "./commonTestFunctions";
import {CognitoAuthorizer} from "uclusion_authorizer_sdk";

module.exports = function(adminConfiguration, adminAuthorizerConfiguration) {
    const adminExpectedStageNames = [ 'Unreviewed', 'Needs Review', 'Needs Investment', 'Under Consideration', 'Complete'];
    const marketOptions = {
        name : 'Default',
        trending_window: 2,
        new_user_grant: 313,
        new_team_grant: 457
    };
    const updateOptions = {
        name : 'fish',
        description: 'this is a fish market',
        trending_window: 5
    };

    const stageInfo = {
        name: 'Test Stage',
        appears_in_market_summary: true,
        allows_investment: true,
        allows_refunds: false,
        visible_to_roles: ['MarketAnonymousUser', 'MarketUser']
    };

    describe('#doCreate, stage list, update, grant, create stage, and follow market', () => {
        it('should create market without error', async() => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalStageId;
            await promise.then((client) => {
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                const configuration = {...adminConfiguration};
                const adminAuthorizerConfig = {...adminAuthorizerConfiguration};
                adminAuthorizerConfig.marketId = response.market_id;
                configuration.authorizer = new CognitoAuthorizer(adminAuthorizerConfig);
                return uclusion.constructClient(configuration);
            }).then((client) => {
                globalClient = client;
                return globalClient.markets.listStages();
            }).then((stageList) => {
                checkStages(adminExpectedStageNames, stageList);
                return globalClient.markets.createStage(stageInfo);
            }).then((stage) => {
                verifyStage(stageInfo, stage);
                globalStageId = stage.id;
                return globalClient.markets.followStage(globalStageId);
            }).then((response) => {
                assert(response.following === true, 'Following is incorrect');
                return globalClient.markets.listStages();
            }).then((stageList) => {
                const newStageNames = [...adminExpectedStageNames];
                newStageNames.push(stageInfo.name);
                checkStages(newStageNames, stageList);
                const followedStage = stageList.find(stage => { return stage.id === globalStageId});
                assert(followedStage.following === true, 'Following should be true from list');
                return globalClient.markets.get();
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.trending_window === 2, 'Trending window is incorrect, should be 2');
                assert(market.account_name, 'Market should have an account name');
                assert(market.new_team_grant === 457, 'New team grant should match definition');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                updateOptions.initial_stage_id = market.initial_stage_id;
                return globalClient.markets.updateMarket(updateOptions);
            }).then((response) => globalClient.markets.get()
            ).then((market) => {
                assert(market.name === 'fish', 'Name is incorrect');
                assert(market.description === 'this is a fish market', 'Description is incorrect');
                assert(market.trending_window === 5, 'Trending window is incorrect, should be 5');
                return globalClient.users.grant(adminConfiguration.userId, 1000);
            }).then((response) => {
                return globalClient.markets.followMarket(false);
            }).then((response) => {
                assert(response.following === true, 'Following incorrect, should be true');
                return globalClient.markets.get();
            }).then((market) => {
                assert(market.unspent === 1000, 'Quantity is incorrect, should be 1000 instead of ' + market.unspent);
                return globalClient.users.get();
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.following === true, 'Following should be true');
                assert(userPresence.quantity === 1000, 'Quantity should be 1000');
                return globalClient.markets.deleteMarket();
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};