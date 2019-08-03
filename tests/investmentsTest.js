import assert from 'assert';
import uclusion from 'uclusion_sdk';
import { WebSocketRunner } from '../src/WebSocketRunner';
import { arrayEquals, sleep } from './commonTestFunctions';
import {CognitoAuthorizer} from 'uclusion_authorizer_sdk';

module.exports = function (adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration, numUsers) {
    const fishOptions = {
        name: 'fish',
        description: 'this is a fish market',
        expiration_minutes: 30,
        new_user_grant: 313
    };
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000});
    const updateFish = {
        name: 'pufferfish',
        description: 'possibly poisonous',
        label_list: ['freshwater', 'spawning']
    };

    describe('#doInvestment', () => {
        it('should create investment without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalUserClient;
            let globalUserId;
            let globalMarketId;
            let marketInvestibleId;
            let globalStages;
            await promise.then((client) => {
                globalClient = client;
                return globalClient.markets.createMarket(fishOptions);
            }).then((response) => {
                const configuration = {...adminConfiguration};
                const adminAuthorizerConfig = {...adminAuthorizerConfiguration};
                adminAuthorizerConfig.marketId = response.market_id;
                configuration.authorizer = new CognitoAuthorizer(adminAuthorizerConfig);
                globalMarketId = response.market_id;
                return uclusion.constructClient(configuration);
            }).then((client) => {
                globalClient = client;
                console.log('Market ID is ' + globalMarketId);
                const userConfig = {...userConfiguration};
                const userAuthorizerConfig = {...userAuthorizerConfiguration};
                userAuthorizerConfig.marketId = globalMarketId;
                userConfig.authorizer = new CognitoAuthorizer(userAuthorizerConfig);
                return uclusion.constructClient(userConfig);
            }).then((client) => {
                globalUserClient = client;
                return sleep(7000);
            }).then(() => globalUserClient.users.get()).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === fishOptions.new_user_grant, 'Quantity is ' + userPresence.quantity);
                webSocketRunner.connect();
                webSocketRunner.subscribe(user.id, { market_id : globalMarketId });
                globalUserId = user.id;
                return globalUserClient.investibles.create('salmon', 'good on bagels');
            }).then((response) => {
                marketInvestibleId = response.id;
                console.log('Investible ID is ' + marketInvestibleId);
                return globalClient.users.grant(globalUserId, 9000);
            }).then((response) => {
                // Give async processing time to complete - including the grants to user
                return sleep(5000);
            }).then((response) => {
                return globalUserClient.markets.updateInvestment(marketInvestibleId, 2000, 0);
            }).then((investment) => {
                assert(investment.quantity === 2000, 'investment quantity should be 2000');
                return globalUserClient.investibles.follow(marketInvestibleId, false);
            }).then((response) => {
                assert(response.following === true, 'follow should return true');
                return globalUserClient.investibles.createComment(marketInvestibleId, 'body of my comment');
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'INVESTIBLE_COMMENT_UPDATED'})
                  .then((payload) => response);
            }).then((comment) => {
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                assert(comment.is_official === false, 'comment should not be official');
                return globalUserClient.investibles.updateComment(comment.id, 'new body');
            }).then((comment) => {
                assert(comment.body === 'new body', 'updated comment body incorrect');
                return globalClient.investibles.createComment(marketInvestibleId, 'comment to fetch');
            }).then((comment) => {
                assert(comment.body === 'comment to fetch', 'comment body incorrect');
                assert(comment.is_official === true, 'comment should be official');
                return globalUserClient.investibles.getMarketComments([comment.id]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === globalMarketId, 'market was not set properly on the comment');
                return globalUserClient.users.get();
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === fishOptions.new_user_grant + 7000, 'Quantity was instead ' + userPresence.quantity + ' for ' + user.id);
                return globalClient.investibles.update(marketInvestibleId, updateFish.name,
                    updateFish.description, updateFish.label_list);
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId})
                  .then((payload) => response);
            }).then((response) => {
                assert(response.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(response.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                assert(arrayEquals(response.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                return globalUserClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles[0];
                assert(investible.name === 'pufferfish', 'get market investible name incorrect');
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                assert(arrayEquals(investible.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                assert(investible.quantity === 2000, 'get market investible quantity incorrect');
                assert(investible.current_user_is_following === true, 'current_user_is_following should return true');
                return globalClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                return globalUserClient.markets.get();
            }).then((market) => {
                //console.log(market);
                assert(market.active_investments === 2000, 'active investments should be 2000');
                assert(market.users_in === numUsers, 'There are ' + market.users_in + ' users in this market');
                assert(market.unspent === 2*fishOptions.new_user_grant + 7000, 'Unspent is in fact ' + market.unspent);
                const current_stage = globalStages.find(stage => { return stage.name === 'Unreviewed'});
                const stage = globalStages.find(stage => { return stage.name === 'Needs Investment'});
                let stateOptions = {
                    current_stage_id: current_stage.id,
                    stage_id: stage.id
                };
                return globalClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then((response) => {
                return sleep(10000);
            }).then((response) => {
                return globalClient.summaries.marketSummary();
            }).then((summaries) => {
                assert(summaries.market_id === globalMarketId);
                assert(summaries.summaries.length === 1, 'There should be 1 day of summary data for a new market');
                const todaysSummary = summaries.summaries[0];
                assert(todaysSummary.unspent_shares === 2*fishOptions.new_user_grant + 7000, 'Unspent wrong in summary');
                assert(todaysSummary.num_users === numUsers, 'There are ' + todaysSummary.num_users + ' in the market');
                return globalUserClient.markets.updateInvestment(marketInvestibleId, 0, 2000);
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId})
                    .then((payload) => response);
            }).then(() => {
                return webSocketRunner.terminate();
            }).then(() => globalUserClient.markets.getMarketInvestibles([marketInvestibleId])
            ).then((investibles) => {
                let investible = investibles[0];
                const current_stage = globalStages.find(stage => { return stage.name === 'Needs Investment'});
                assert(investible.stage === current_stage.id, 'Instead of ' + investible.stage + ' which is ' + investible.stage_name);
                assert(investible.open_for_investment === true, 'open_for_investment true');
                assert(investible.open_for_refunds === true, 'open_for_refunds true');
                assert(investible.is_active === true, 'is_active true');
                assert(investible.quantity === 0, 'investment should be updated to zero');
                return globalClient.markets.deleteMarket();
            }).catch(function (error) {
                    console.log(error);
                    //close our websocket
                    webSocketRunner.terminate();
                    throw error;
            });
        }).timeout(120000);
    });
};


