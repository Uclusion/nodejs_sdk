import assert from 'assert'
import {uclusion} from "../src/uclusion";
import { WebSocketRunner } from "../src/websocketRunner"

module.exports = function (adminConfiguration, userConfiguration, userId, numUsers) {
    const fishOptions = {
        name: 'fish',
        description: 'this is a fish market',
        trending_window: 5,
        manual_roi: false,
        initial_next_stage: 'fishing',
        initial_next_stage_threshold: 0,
        new_user_grant: 313,
        new_team_grant: 457,
    };
    const expectedWebsocketMessages = [];
    const webSocketRunner = new WebSocketRunner({ wsUrl: adminConfiguration.websocketURL, reconnectInterval: 3000})
    const updateFish = {
        name: 'pufferfish',
        description: 'possibly poisonous',
        category_list: ['poison', 'chef']
    };
    const verifyExpectedMessages = (messageQueue) => {
        //console.log(expectedWebsocketMessages);
        //console.log(messageQueue);
        for (const expected of expectedWebsocketMessages){
            //console.log("Looking for message");
            //console.log(expected);
            const found = messageQueue.find((element) => {
                //console.log("Processing element");
                //console.log(element);
                const event_type_match = element.event_type === expected.event_type;
                //console.log("Event Type Match: " + event_type_match);
                const object_id_match = element.object_id === expected.object_id;
                //console.log("Object Id Match: " + object_id_match);
                return event_type_match && object_id_match;
            });
            assert(found, 'Did not find message on websocket we were expecting');
        }
    };
    describe('#doInvestment', () => {
        it('should create investment without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let userPromise = uclusion.constructClient(userConfiguration);
            let globalClient;
            let adminUserId;
            let globalUserClient;
            let globalMarketId;
            let globalInvestibleId;
            let marketInvestibleId;
            let investmentId;
            let globalUserTeamId;
            await userPromise.then((client) => {
                globalUserClient = client;
                return promise;
            }).then((client) => {
                globalClient = client;
                return client.users.get();
            }).then((user) => {
                adminUserId = user.id;
                return globalClient.markets.createMarket(fishOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                console.log('Market ID is ' + globalMarketId);
                webSocketRunner.connect();
                webSocketRunner.subscribe(userId, { market_id : globalMarketId });
                return globalUserClient.investibles.create('salmon', 'good on bagels');
            }).then((response) => {
                globalInvestibleId = response.id;
                return globalUserClient.users.get(userId);
            }).then((response) => {
                globalUserTeamId = response.team_id;
                return globalClient.teams.bind(globalUserTeamId, globalMarketId);
            }).then((response) => {
                return sleep(5000);
            }).then((response) => {
                console.log('Investing User ID is ' + userId);
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                // 914 = 457 from new team, 457 from user who's part of team
                assert(userPresence.quantity === 914, 'Quantity should be 900 instead of ' + userPresence.quantity);
                return user; // ignored anyways
            }).then((response) => {
                return globalClient.users.grant(userId, globalMarketId, 9000);
            }).then((response) => {
                return globalClient.investibles.createCategory('fish', globalMarketId);
            }).then((response) => {
                return globalClient.investibles.createCategory('water', globalMarketId);
            }).then((response) => {
                // Give async processing time to complete - including the grants to user and team
                // Otherwise the team 457can't be used an the numbers come out wrong
                return sleep(5000);
            }).then((response) => {
                return globalUserClient.markets.investAndBind(globalMarketId, globalUserTeamId, globalInvestibleId, 2000, ['fish', 'water']);
            }).then((response) => {
                let investment = response.investment;
                investmentId = investment.id;
                marketInvestibleId = investment.investible_id;
                expectedWebsocketMessages.push({event_type: 'MARKET_INVESTIBLE_CREATED', object_id: marketInvestibleId});
                assert(investment.quantity === 2000, 'investment quantity should be 2000');
                expectedWebsocketMessages.push({event_type: 'MARKET_INVESTIBLE_UPDATED', object_id: marketInvestibleId});
                return globalUserClient.investibles.follow(marketInvestibleId, false);
            }).then((response) => {
                assert(response.following === true, 'follow should return true');
                // Workaround for investors coming up empty and so comment create not allowed
                return sleep(15000);
            }).then((response) => {
                return globalUserClient.investibles.createComment(marketInvestibleId, 'body of my comment');
            }).then((comment) => {
                assert(comment.body === 'body of my comment', 'comment body incorrect');
                expectedWebsocketMessages.push({event_type: 'INVESTIBLE_COMMENT_UPDATED', object_id: comment.id});
                return globalUserClient.investibles.updateComment(comment.id, 'new body');
            }).then((comment) => {
                assert(comment.body === 'new body', 'updated comment body incorrect');
                return globalUserClient.investibles.createComment(marketInvestibleId, 'comment to fetch');
            }).then((comment) => {
                assert(comment.body === 'comment to fetch', 'comment body incorrect');
                return globalUserClient.investibles.getMarketComments(globalMarketId, [comment.id]);
            }).then((comments) => {
                let comment = comments[0];
                assert(comment.body === 'comment to fetch', 'fetched comment body incorrect');
                assert(comment.market_id === globalMarketId, 'market was not set properly on the comment');
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                // 7914 = (9000 - 2000) + 450 + 457 where 450 for user and another 457 spent from shared team
                // The spending bonus should not be here unless integration tests run with a new user (then 8371)
                assert(userPresence.quantity === 7914, 'Quantity should be 7914 instead of ' + userPresence.quantity);
                return globalUserClient.markets.deleteInvestment(globalMarketId, investmentId);
            }).then((response) => {
                // Give the investment refund time to kick in
                return sleep(15000);
            }).then((response) => {
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === 9914, 'Quantity should be 9914 instead of ' + userPresence.quantity);
                return globalClient.teams.get(globalUserTeamId);
            }).then((response) => {
                return globalUserClient.users.get(response.team.user_id, globalMarketId);
            }).then((teamUser) => {
                assert(teamUser.type === 'TEAM', 'Team user type incorrect');
                // Ideally the team user would get back the 457 instead of it going to the investing user but not the case
                let userPresence = teamUser.market_presence;
                assert(userPresence.quantity === 0, 'Quantity should be 0 instead of ' + userPresence.quantity);
                return globalClient.investibles.createCategory('poison', globalMarketId);
            }).then((response) => {
                return globalClient.investibles.createCategory('chef', globalMarketId);
            }).then((response) => {
                return globalUserClient.investibles.updateInMarket(marketInvestibleId, globalMarketId, updateFish.name, updateFish.description, updateFish.category_list);
            }).then((response) => {
                assert(response.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(response.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                assert(_arrayEquals(response.category_list, ['poison', 'chef']), 'update market investible category list not passed on correctly');
                return globalUserClient.markets.getMarketInvestibles(globalMarketId, [marketInvestibleId]);
            }).then((investibles) => {
                let investible = investibles[0];
                assert(investible.name === 'pufferfish', 'get market investible name incorrect');
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                assert(_arrayEquals(investible.category_list, ['poison', 'chef']), 'get market investible category list incorrect');
                assert(investible.quantity === 0, 'get market investible quantity incorrect');
                return globalUserClient.markets.get(globalMarketId);
            }).then((market) => {
                //console.log(market);
                assert(market.active_investments === 0, 'active investments should be 0');
                assert(market.users_in === numUsers, 'Counting team users there are ' + numUsers + ' users in this market');
                assert(market.team_count === 1, 'One team in this market');
                assert(market.unspent === 9914, 'unspent should be 9914 instead of ' + market.unspent);
                let stateOptions = {
                    open_for_investment: false,
                    open_for_refunds: false,
                    open_for_editing: false,
                    is_active: false,
                    current_stage: 'BOUND',
                    stage: 'REVIEWED',
                    next_stage: 'CLOSED',
                    next_stage_threshold: 10
                };
                return globalClient.investibles.stateChange(marketInvestibleId, stateOptions);
            }).then((response) => {
                sleep(5000)
            }).then((response) => {
                return globalClient.summaries.marketSummary(globalMarketId);
            }).then((summaries) => {
                assert(summaries.market_id === globalMarketId);
                assert(summaries.summaries.length === 1, 'There should be 1 day of summary data for a new market');
                const todaysSummary = summaries.summaries[0];
                assert(todaysSummary.unspent_shares === 9914, 'Unspent should be 9914 for the market summary');
                assert(todaysSummary.num_users === 1, 'There should be one user in the market');
            }).then((result) => globalUserClient.markets.getMarketInvestibles(globalMarketId, [marketInvestibleId])
            ).then((investibles) => {
                let investible = investibles[0];
                assert(investible.stage === 'REVIEWED', 'investible stage should be reviewed');
                assert(investible.next_stage === 'CLOSED', 'investible next stage should be closed');
                assert(investible.next_stage_threshold === 10, 'investible next stage threshold should be 10');
                assert(investible.open_for_investment === false, 'open_for_investment false');
                assert(investible.open_for_refunds === false, 'open_for_refunds false');
                assert(investible.open_for_editing === false, 'open_for_editing false');
                assert(investible.is_active === false, 'is_active false');
                return globalUserClient.investibles.delete(globalInvestibleId);
            }).then((response) => {
                    return globalClient.markets.deleteMarket(globalMarketId);
            }).then((response) => {
                //close our websocket
                webSocketRunner.terminate();
                const messages = webSocketRunner.getMessagesReceived();
                verifyExpectedMessages(messages);
                //we should have roughly 9 messages, though many will be duplicates because the same action was performed
                assert(messages.length === 9, 'Wrong number of messages received on websocket');
                //console.log(messages);
            }).catch(function (error) {
                    console.log(error);
                    throw error;
            });
        }).timeout(120000);
    });
};

let _arrayEquals = (arr1, arr2) => {
    if (arr1.length !== arr2.length)
        return false;
    arr1.forEach(function (e) {
        if (arr2.indexOf(e) < 0)
            return false;
    });
    return true;
};

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    })
}
