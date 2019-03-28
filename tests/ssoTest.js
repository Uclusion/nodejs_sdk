import assert from 'assert'
import { UclusionSSO } from 'uclusion_authorizer_sdk';
import {uclusion} from "../src/uclusion";

module.exports = function(adminConfiguration, adminAuthorizerConfiguration) {
    const marketOptions = {
        name : 'Default',
        description: 'This is default.',
        trending_window: 2,
        manual_roi: false,
        initial_next_stage: 'globaling',
        new_user_grant: 313,
        new_team_grant: 457
    };
    describe('#doPrelogin, ', () => {
        it('should retrieve login info without error', async () => {
            let sso = new UclusionSSO(adminConfiguration.baseURL);
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalMarketId;
            await promise.then((client) => {
                globalClient = client;
                return client.markets.createMarket(marketOptions);
            }).then((market) => {
                //console.log(market);
                globalMarketId = market.market_id;
                return sso.marketLoginInfo(globalMarketId)
            }).then((login_info) => {
                //console.log(login_info);
                assert(login_info.ui_url, 'Markets should have a ui_url');
                assert(login_info.allow_cognito, 'Cognito should be allowed on this test market');
                assert(login_info.allow_user === false, 'User logins should not be supported on this market');
                assert(login_info.allow_anonymous === false, 'Anonymous logins should not be supported on this market');
                assert(login_info.user_pool_id === adminAuthorizerConfiguration.poolId, 'Cognito pool should match the authorizer pool');
                assert(login_info.cognito_client_id === adminAuthorizerConfiguration.clientId, 'Cognito client id should match the authorizer client id');
                return globalClient.teams.bindAnonymous(globalMarketId);
            }).then((marketTeam) => {
                assert(marketTeam.market_id === globalMarketId, 'Should be an anonymous team in this market now');
                return sso.marketLoginInfo(globalMarketId)
            }).then((login_info) => {
                assert(login_info.allow_anonymous === true, 'Anonymous logins should be supported on this market');
                return sso.marketAnonymousLogin(globalMarketId);
            }).then((login) => {
                assert(login.market_id === globalMarketId, 'Anonymous logins should work for this market');
                return globalClient.markets.deleteMarket(globalMarketId);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};
