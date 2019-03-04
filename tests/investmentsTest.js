import assert from 'assert'
import {uclusion} from "../src/uclusion";

module.exports = function (adminConfiguration, userConfiguration, userId, numUsers) {
    const fishOptions = {
        name: 'fish',
        description: 'this is a fish market',
        trending_window: 5,
        manual_roi: false,
        initial_next_stage: 'fishing',
        initial_next_stage_threshold: 0
    };
    const updateFish = {
        name: 'pufferfish',
        description: 'possibly poisonous',
        category_list: ['poison', 'chef']
    };
    describe('#doInvestment', () => {
        it('should create investment without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let userPromise = uclusion.constructClient(userConfiguration);
            let globalClient;
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
                return client.markets.createMarket(fishOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return globalUserClient.investibles.create('salmon', 'good on bagels');
            }).then((response) => {
                globalInvestibleId = response.id;
                return globalUserClient.users.get(userId);
            }).then((response) => {
                globalUserTeamId = response.team_id;
                return globalClient.teams.bind(globalUserTeamId, globalMarketId);
            }).then((response) => {
                return globalClient.users.grant(userId, globalMarketId, 9000);
            }).then((response) => {
                return globalClient.investibles.createCategory('fish', globalMarketId);
            }).then((response) => {
                return globalClient.investibles.createCategory('water', globalMarketId);
            }).then((response) => {
                return globalUserClient.markets.investAndBind(globalMarketId, globalUserTeamId, globalInvestibleId, 2000, ['fish', 'water']);
            }).then((response) => {
                let investment = response.investment;
                investmentId = investment.id;
                marketInvestibleId = investment.investible_id;
                assert(investment.quantity === 2000, 'investment quantity should be 2000');
                return globalUserClient.investibles.follow(marketInvestibleId, false);
            }).then((response) => {
                assert(response.following === true, 'follow should return true');
                return sleep(5000); // Workaround for investors coming up empty and so comment create not allowed
            }).then((response) => {
                return globalUserClient.investibles.createComment(marketInvestibleId, 'body of my comment');
            }).then((comment) => {
                assert(comment.body === 'body of my comment', 'comment body incorrect');
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
                return globalClient.teams.get(globalUserTeamId);
            }).then((response) => {
                return globalUserClient.users.get(response.team.user_id, globalMarketId);
            }).then((response) => {
                assert(response.type === 'TEAM', 'Team user type incorrect');
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === 7450, 'Quantity should be 7450 instead of ' + userPresence.quantity);
                return globalUserClient.markets.deleteInvestment(globalMarketId, investmentId);
            }).then((response) => {
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                //console.log(userPresence);
                assert(userPresence.quantity === 9450, 'Quantity should be 9450 instead of ' + userPresence.quantity);
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
                assert(market.unspent === 9450, 'unspent should be 9450 instead of ' + market.unspent);
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
