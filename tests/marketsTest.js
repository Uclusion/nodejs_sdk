import assert from 'assert'
import {uclusion} from "../src/uclusion";

module.exports = function(adminConfiguration, adminUserId) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        trending_window: 2,
        manual_roi: false,
        initial_next_stage: 'globaling',
        new_user_grant: 313,
        new_team_grant: 457
    };
    const updateOptions = {
        name : 'fish',
        description: 'this is a fish market',
        trending_window: 5,
        initial_next_stage: 'fishy',
        initial_next_stage_threshold: 1
    };
    describe('#doCreate, update, grant, and follow market', () => {
        it('should create market without error', async() => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalMarketId;
            await promise.then((client) => {
                globalClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return globalClient.markets.get(response.market_id);
            }).then((market) => {
                assert(market.name === 'Default', 'Name is incorrect');
                assert(market.description === 'This is default.', 'Description is incorrect');
                assert(market.trending_window === 2, 'Trending window is incorrect, should be 2');
                assert(market.manual_roi === false, 'Roi is incorrect, should be false');
                assert(market.account_name, 'Market should have an account name');
                assert(market.initial_next_stage_threshold === 6000, 'Initial next stage threshold should be 6000 instead of ' + market.initial_next_stage_threshold);
                assert(market.initial_next_stage === 'globaling', 'Initial next stage is incorrect, should be globaling');
                assert(market.new_team_grant === 457, 'New team grant should match definition');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                return globalClient.markets.updateMarket(globalMarketId, updateOptions);
            }).then((response) => globalClient.markets.get(globalMarketId)
            ).then((market) => {
                assert(market.name === 'fish', 'Name is incorrect');
                assert(market.description === 'this is a fish market', 'Description is incorrect');
                assert(market.trending_window === 5, 'Trending window is incorrect, should be 5');
                assert(market.initial_next_stage_threshold === 1, 'Initial next stage threshold is incorrect, should be 1');
                assert(market.initial_next_stage === 'fishy', 'Initial next stage is incorrect, should be fishy');
                return globalClient.users.grant(adminUserId, globalMarketId, 1000);
            }).then((response) => {
                return globalClient.markets.followMarket(globalMarketId, false);
            }).then((response) => {
                    assert(response.following === true, 'Following incorrect, should be true');
                    return globalClient.markets.get(globalMarketId);
                }
            ).then((market) => {
                assert(market.unspent === 1000, 'Quantity is incorrect, should be 1000');
                return globalClient.users.get(adminUserId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.following === true, 'Following should be true');
                assert(userPresence.quantity === 1000, 'Quantity should be 1000')
            }).then((response) => {
                return globalClient.markets.deleteMarket(globalMarketId);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};