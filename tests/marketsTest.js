import assert from 'assert'
import {uclusion} from "../src/uclusion";
import {checkStages, verifyStage} from "./commonTestFunctions";

module.exports = function(adminConfiguration) {
    const adminExpectedStageNames = [ 'Unreviewed', 'Needs Review', 'Needs Investment', 'Under Consideration', 'Complete'];
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        trending_window: 2,
        manual_roi: false,
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
        allows_editing: false,
        visible_to_roles: ['MarketAnonymousUser', 'MarketUser']
    };

    describe('#doCreate, stage list, update, grant, create stage, and follow market', () => {
        it('should create market without error', async() => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalMarketId;
            let globalStageId;
            await promise.then((client) => {
                globalClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return globalClient.markets.listStages(globalMarketId);
            }).then((stageList) => {
                checkStages(adminExpectedStageNames, stageList);
                return globalClient.markets.createStage(globalMarketId, stageInfo);
            }).then((stage) => {
                verifyStage(stageInfo, stage);
                globalStageId = stage.id;
                return globalClient.markets.followStage(globalStageId, globalMarketId);
            }).then((response) => {
                assert(response.following === true, 'Following is incorrect');
                return globalClient.markets.listStages(globalMarketId);
            }).then((stageList) => {
                const newStageNames = [...adminExpectedStageNames];
                newStageNames.push(stageInfo.name);
                checkStages(newStageNames, stageList);
                const followedStage = stageList.find(stage => { return stage.id === globalStageId});
                assert(followedStage.following === true, 'Following should be true from list');
                return globalClient.markets.get(globalMarketId);
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.description === 'This is default.', 'Description is incorrect');
                assert(market.trending_window === 2, 'Trending window is incorrect, should be 2');
                assert(market.manual_roi === false, 'Roi is incorrect, should be false');
                assert(market.account_name, 'Market should have an account name');
                assert(market.new_team_grant === 457, 'New team grant should match definition');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                updateOptions.initial_stage_id = market.initial_stage_id;
                return globalClient.markets.updateMarket(globalMarketId, updateOptions);
            }).then((response) => globalClient.markets.get(globalMarketId)
            ).then((market) => {
                assert(market.name === 'fish', 'Name is incorrect');
                assert(market.description === 'this is a fish market', 'Description is incorrect');
                assert(market.trending_window === 5, 'Trending window is incorrect, should be 5');
                return globalClient.users.grant(adminConfiguration.userId, globalMarketId, 1000);
            }).then((response) => {
                return globalClient.markets.followMarket(globalMarketId, false);
            }).then((response) => {
                assert(response.following === true, 'Following incorrect, should be true');
                return globalClient.markets.get(globalMarketId);
            }).then((market) => {
                assert(market.unspent === 1000, 'Quantity is incorrect, should be 1000');
                return globalClient.users.get(adminConfiguration.userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.following === true, 'Following should be true');
                assert(userPresence.quantity === 1000, 'Quantity should be 1000');
                return globalClient.markets.deleteMarket(globalMarketId);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};