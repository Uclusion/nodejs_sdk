import assert from 'assert';
import { WebSocketRunner } from '../src/WebSocketRunner';
import { arrayEquals, sleep } from './commonTestFunctions';
import {loginUserToAccount, loginUserToMarket} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration, numUsers) {
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
            let promise = loginUserToAccount(adminConfiguration);
            let adminClient;
            let userClient;
            let userId;
            let createdMarketId;
            let marketInvestibleId;
            let globalStages;
            await promise.then((client) => {
                return client.markets.createMarket(fishOptions);
            }).then((response) => {
                createdMarketId = response.market_id;
                console.log(`Logging admin into market ${createdMarketId}`);
                return loginUserToMarket(adminConfiguration, createdMarketId);
            }).then((client) => {
                adminClient = client;
                console.log(`Logging user into market ${createdMarketId}`);
                return loginUserToMarket(userConfiguration, createdMarketId);
            }).then((client) => {
                userClient = client;
                return sleep(7000);
            }).then(() => userClient.users.get()).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === fishOptions.new_user_grant, 'Quantity is ' + userPresence.quantity);
                webSocketRunner.connect();
                webSocketRunner.subscribe(user.id, { market_id : createdMarketId });
                userId = user.id;
                return userClient.investibles.create('salmon', 'good on bagels');
            }).then((response) => {
                marketInvestibleId = response.id;
                console.log('Investible ID is ' + marketInvestibleId);
                return adminClient.markets.listStages();
            }).then((stages) => {
                globalStages = stages;
                const current_stage = globalStages.find(stage => { return stage.name === 'Created'});
                const stage = globalStages.find(stage => { return stage.name === 'In Moderation'});
                let stateOptions = {
                    current_stage_id: current_stage.id,
                    stage_id: stage.id
                };
                return userClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then(() => {
                return adminClient.users.grant(userId, 9000);
            }).then((response) => {
                // Give async processing time to complete - including the grants to user
                return sleep(5000);
            }).then(() => {
                const current_stage = globalStages.find(stage => { return stage.name === 'In Moderation'});
                const stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                let stateOptions = {
                    current_stage_id: current_stage.id,
                    stage_id: stage.id
                };
                return adminClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then((response) => {
                return userClient.markets.updateInvestment(marketInvestibleId, 2000, 0);
            }).then((investment) => {
                assert(investment.quantity === 2000, 'investment quantity should be 2000');
                return userClient.investibles.follow(marketInvestibleId, false);
            }).then((response) => {
                assert(response.following === true, 'follow should return true');
                return userClient.investibles.createComment(null, 'body of my comment');
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'INVESTIBLE_COMMENT_UPDATED'})
                  .then((payload) => response);
            }).then((comment) => {
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                assert(comment.is_official === false, 'comment should not be official');
                return userClient.investibles.updateComment(comment.id, 'new body', true);
            }).then((comment) => {
                assert(comment.body === 'new body', 'updated comment body incorrect');
                assert(comment.is_resolved, 'updated comment is_resolved incorrect');
                return adminClient.investibles.createComment(marketInvestibleId, 'comment to fetch');
            }).then((comment) => {
                assert(comment.body === 'comment to fetch', 'comment body incorrect');
                assert(comment.is_official === true, 'comment should be official');
                return userClient.investibles.getMarketComments([comment.id]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === createdMarketId, 'market was not set properly on the comment');
                return userClient.users.get();
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === fishOptions.new_user_grant + 7000, 'Quantity was instead ' + userPresence.quantity + ' for ' + user.id);
                return adminClient.investibles.update(marketInvestibleId, updateFish.name,
                    updateFish.description, updateFish.label_list);
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId})
                  .then((payload) => response);
            }).then((response) => {
                assert(response.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(response.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                assert(arrayEquals(response.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                return userClient.markets.getMarketInvestibles([marketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles[0];
                assert(investible.name === 'pufferfish', 'get market investible name incorrect');
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                assert(arrayEquals(investible.label_list, ['freshwater', 'spawning']), 'update market investible label list not passed on correctly');
                assert(investible.quantity === 2000, 'get market investible quantity incorrect');
                assert(investible.current_user_is_following === true, 'current_user_is_following should return true');
                return userClient.markets.get();
            }).then((market) => {
                //console.log(market);
                assert(market.active_investments === 2000, 'active investments should be 2000');
                assert(market.users_in === numUsers, 'There are ' + market.users_in + ' users in this market');
                assert(market.unspent === 2*fishOptions.new_user_grant + 7000, 'Unspent is in fact ' + market.unspent);
                return sleep(10000);
            }).then((response) => {
                return adminClient.summaries.marketSummary();
            }).then((summaries) => {
                assert(summaries.market_id === createdMarketId);
                assert(summaries.summaries.length === 1, 'There should be 1 day of summary data for a new market');
                const todaysSummary = summaries.summaries[0];
                assert(todaysSummary.unspent_shares === 2*fishOptions.new_user_grant + 7000, 'Unspent wrong in summary');
                assert(todaysSummary.num_users === numUsers, 'There are ' + todaysSummary.num_users + ' in the market');
                return userClient.markets.updateInvestment(marketInvestibleId, 0, 2000);
            }).then((response) => {
                return webSocketRunner.waitForReceivedMessage({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId})
                    .then((payload) => response);
            }).then(() => {
                return webSocketRunner.terminate();
            }).then(() => userClient.markets.getMarketInvestibles([marketInvestibleId])
            ).then((investibles) => {
                let investible = investibles[0];
                const current_stage = globalStages.find(stage => { return stage.name === 'In Dialog'});
                assert(investible.stage === current_stage.id, 'Instead of ' + investible.stage + ' which is ' + investible.stage_name);
                assert(investible.open_for_investment === true, 'open_for_investment true');
                assert(investible.open_for_refunds === true, 'open_for_refunds true');
                assert(investible.quantity === 0, 'investment should be updated to zero');
                return adminClient.markets.deleteMarket();
            }).catch(function (error) {
                    console.log(error);
                    //close our websocket
                    webSocketRunner.terminate();
                    throw error;
            });
        }).timeout(120000);
    });
};


