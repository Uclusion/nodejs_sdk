import assert from 'assert'
import uclusion from 'uclusion_sdk';
import {checkStages, verifyStage} from "./commonTestFunctions";
import {CognitoAuthorizer} from "uclusion_authorizer_sdk";
import {WebSocketRunner} from "../src/WebSocketRunner";

module.exports = function(adminConfiguration, adminAuthorizerConfiguration) {
    const adminExpectedStageNames = [ 'Unreviewed', 'Needs Review', 'Needs Investment', 'Under Consideration', 'Complete'];
    const marketOptions = {
        name : 'Default',
        expiration_minutes: 2,
        new_user_grant: 313
    };
    const updateOptions = {
        name : 'fish',
        description: 'this is a fish market'
    };

    const stageInfo = {
        name: 'Test Stage',
        appears_in_market_summary: true,
        allows_investment: true,
        allows_refunds: false,
        visible_to_roles: ['MarketAnonymousUser', 'MarketUser']
    };
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000});
    webSocketRunner.connect();
    describe('#doCreate, stage list, update, grant, create stage, and follow market', () => {
        it('should create market without error', async() => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalStageId;
            let globalMarketId;
            await promise.then((client) => {
                return client.markets.createMarket(marketOptions);
            }).then((response) => {
                const configuration = {...adminConfiguration};
                const adminAuthorizerConfig = {...adminAuthorizerConfiguration};
                globalMarketId = response.market_id;
                adminAuthorizerConfig.marketId = response.market_id;
                configuration.authorizer = new CognitoAuthorizer(adminAuthorizerConfig);
                return uclusion.constructClient(configuration);
            }).then((client) => {
                globalClient = client;
                return globalClient.users.get();
            }).then((user) => {
                // Have 2 minutes to get here so that can receive the market update for the market expiring
                webSocketRunner.subscribe(user.id, {market_id: globalMarketId});
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_UPDATED', object_id: globalMarketId});
            }).then(() => globalClient.markets.listStages()).then((stageList) => {
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
                assert(market.active === false, 'Market should have expired while waiting above');
                assert(market.expiration_minutes === marketOptions.expiration_minutes, 'expiration_minutes is incorrect');
                assert(market.account_name, 'Market should have an account name');
                assert(market.new_user_grant === 313, 'New user grant should match definition');
                webSocketRunner.terminate();
                return globalClient.markets.deleteMarket();
            }).catch(function(error) {
                webSocketRunner.terminate();
                console.log(error);
                throw error;
            });
        }).timeout(300000);
    });
};