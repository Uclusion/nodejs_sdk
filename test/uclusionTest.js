import assert from 'assert'

import {uclusion, CognitoAuthorizer} from "../src/uclusion";

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_Z3vZuhzd2',
    clientId: '2off68ct2ntku805jt7sip0j1b'
};

const adminAuthorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);

const adminConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    authorizer: adminAuthorizer
};

const userAuthorizerConfiguration = {
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_Z3vZuhzd2',
    clientId: '2off68ct2ntku805jt7sip0j1b'
};

const userAuthorizer = new CognitoAuthorizer(userAuthorizerConfiguration);

const userConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    authorizer: userAuthorizer
};

const marketOptions = {
    name : 'Default',
    description: 'This is default.',
    trending_window: 2,
    manual_roi: false
};
const updateOptions = {
    name : 'fish',
    description: 'this is a fish market',
    trending_window: 5
};
const fishOptions = {
    name : 'fish',
    description: 'this is a fish market',
    trending_window: 5,
    manual_roi: false,
};
const updateFish = {
    name : 'pufferfish',
    description: 'possibly poisonous',
    category_list: ['poison', 'chef']
};

const adminUserId = '03e134fb-44bc-42d2-a499-316f7260da35';
const userId = '0404c4f1-600a-4788-ac8d-f5556ae2e573';

let marketIdList = [];
describe('uclusion', () => {
    describe('#doLogin and update user', () => {
        it('should login and pull without error', () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            promise.then((client) => {
                globalClient = client;
                return client.users.update('Daniel');
            }).then((response) => {
                assert(response.success_message === 'User updated', 'User update was not successful');
                return globalClient.users.get(adminUserId);
            }).then((user) => {
                //console.log(user);
                assert(adminUserId === user.id, 'Fetched user did not match me');
                assert(user.name === 'Daniel', 'Name not updated properly');
                return globalClient.users.update('Default');
            }).catch(function(error) {
                console.log(error);
            });
        });
    });
    describe('#doCreate, update, grant, and follow market', () => {
        it('should create market without error', () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            let globalMarketId;
            promise.then((client) => {
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
                return globalClient.markets.updateMarket(globalMarketId, updateOptions);
            }).then((response) => globalClient.markets.get(globalMarketId)
            ).then((market) => {
                assert(market.name === 'fish', 'Name is incorrect');
                assert(market.description === 'this is a fish market', 'Description is incorrect');
                assert(market.trending_window === 5, 'Trending window is incorrect, should be 5');
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
            });
        });
    });
    describe('#doCreateInvestible, ', () => {
        it('should create investible without error', () => {
            let promise = uclusion.constructClient(userConfiguration);
            let globalClient;
            let globalInvestibleId;
            promise.then((client) => {
                globalClient = client;
                return client.investibles.create('salmon', 'good on bagels', ['fish', 'water']);
            }).then((response) => {
                //console.log(response);
                globalInvestibleId = response.id;
                assert(response.name === 'salmon', 'name not passed on correctly');
                assert(response.description === 'good on bagels', 'description not passed on correctly');
                assert(_arrayEquals(response.category_list, ['fish', 'water']), 'category list not passed on correctly');
                return globalClient.investibles.update(globalInvestibleId, 'tuna', 'good for sandwich', ['can', 'sandwich']);
            }).then((response) => {
                //console.log(response);
                assert(response.name === 'tuna', 'name not passed on correctly');
                assert(response.description === 'good for sandwich', 'description not passed on correctly');
                assert(_arrayEquals(response.category_list, ['can', 'sandwich']), 'update category list not correct');
                return globalClient.investibles.get(globalInvestibleId);
            }).then((investible) => {
                //console.log(investible);
                assert(investible.name === 'tuna', 'name not passed on correctly');
                assert(investible.description === 'good for sandwich', 'description not passed on correctly');
                assert(_arrayEquals(investible.category_list, ['can', 'sandwich']), 'category list not passed on correctly');
                return globalClient.investibles.delete(globalInvestibleId);
            }).catch(function(error) {
                console.log(error);
            });
        });
    });
   describe('#doInvestment', () => {
        it('should create investment without error', () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let userPromise = uclusion.constructClient(userConfiguration);
            let globalClient;
            let globalUserClient;
            let globalMarketId;
            let globalInvestibleId;
            let marketInvestibleId;
            let investmentId;
            let globalUserTeamId;
            userPromise.then((client) => {
                globalUserClient = client;
                return promise;
            }).then((client) => {
                globalClient = client;
                return client.markets.createMarket(fishOptions);
            }).then((response) => {
                globalMarketId = response.market_id;
                return globalUserClient.investibles.create('salmon', 'good on bagels', ['fish', 'water']);
            }).then((response) => {
                globalInvestibleId = response.id;
                return globalUserClient.users.get(userId);
            }).then((response) => {
                globalUserTeamId = response.team_id;
                return globalClient.teams.bind(globalUserTeamId, globalMarketId, false);
            }).then((response) => {
                return globalClient.users.grantAddExistingUserToMarket(userId, globalMarketId, globalUserTeamId, 10000, false);
            }).then((response) => {
                return globalUserClient.markets.createInvestment(globalMarketId, globalUserTeamId, globalInvestibleId, 1000);
            }).then((response) => {
                investmentId = response.id;
                marketInvestibleId = response.investible_id;
                assert(response.quantity === 1000, 'investment quantity should be 1000');
                return globalUserClient.investibles.follow(marketInvestibleId, false);
            }).then((response) => {
                assert(response.following === true, 'follow should return true');
                return globalUserClient.markets.getMarketInvestible(globalMarketId, marketInvestibleId);
            }).then((investible) => {
                //console.log(response);
                assert(investible.quantity === 1000, 'get investible quantity should return 1000');
                assert(investible.following === true, 'get investible following should be true');
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                assert(userPresence.quantity === 9000, 'Quantity should be 9000');
                return globalUserClient.markets.deleteInvestment(globalMarketId, investmentId);
            }).then((response) => {
                return globalUserClient.users.get(userId, globalMarketId);
            }).then((user) => {
                let userPresence = user.market_presence;
                //console.log(userPresence);
                assert(userPresence.quantity === 10000, 'Quantity should be 10000');
                return globalUserClient.investibles.updateInMarket(marketInvestibleId, globalMarketId, updateFish.name, updateFish.description, updateFish.category_list);
            }).then((response) => {
                assert(response.name === 'pufferfish', 'update market investible name not passed on correctly');
                assert(response.description === 'possibly poisonous', 'update market investible description not passed on correctly');
                assert(_arrayEquals(response.category_list, ['poison', 'chef']), 'update market investible category list not passed on correctly');
                return globalUserClient.markets.getMarketInvestible(globalMarketId, marketInvestibleId);
            }).then((investible) => {
                //console.log(investible);
                assert(investible.name === 'pufferfish', 'get market investible name incorrect');
                assert(investible.description === 'possibly poisonous', 'get market investible description incorrect');
                assert(_arrayEquals(investible.category_list, ['poison', 'chef']), 'get market investible category list incorrect');
                assert(investible.quantity === 0, 'get market investible quantity incorrect');
                return globalUserClient.markets.get(globalMarketId);
            }).then((market) => {
                //console.log(market);
                assert(market.open_investments === 0, 'open investments should be 0');
                assert(market.unspent === 10000, 'unspent should be 10000');
                return globalClient.investibles.resolve(marketInvestibleId);
            }).then((result) => globalUserClient.markets.getMarketInvestible(globalMarketId, marketInvestibleId)
            ).then((investible) => {
                //console.log(investible);
                assert(investible.closed === true, 'investible should be closed');
                assert(investible.marked_resolved_by === adminUserId, 'resolved by user id is incorrect');
                return globalUserClient.investibles.delete(globalInvestibleId);
            }).then((response) => {
                return globalClient.markets.deleteMarket(globalMarketId);
            }).catch(function(error) {
                console.log(error);
            });
        });
         describe('#doList', () => {
            it('should list without error', () => {
                let promise = uclusion.constructClient(adminConfiguration);
                let userPromise = uclusion.constructClient(userConfiguration);
                let globalClient;
                let globalUserClient;
                let globalMarketId;
                let globalInvestibleId;
                let marketInvestibleId;
                let investmentId;
                let globalUserTeamId;
                userPromise.then((client) => {
                    globalUserClient = client;
                    return promise;
                }).then((client) => {
                    globalClient = client;
                    return client.markets.createMarket(fishOptions);
                }).then((response) => {
                    globalMarketId = response.market_id;
                    return globalUserClient.investibles.create('salmon', 'good on bagels', ['fish', 'water']);
                }).then((response) => {
                    globalInvestibleId = response.id;
                    return globalUserClient.users.get(userId);
                }).then((response) => {
                    globalUserTeamId = response.team_id;
                    return globalClient.teams.bind(globalUserTeamId, globalMarketId, false);
                }).then((response) => {
                    return globalClient.users.grantAddExistingUserToMarket(userId, globalMarketId, globalUserTeamId, 10000, false);
                }).then((response) => {
                    return globalUserClient.markets.createInvestment(globalMarketId, globalUserTeamId, globalInvestibleId, 1000);
                }).then((response) => {
                    //console.log(response);
                    investmentId = response.id;
                    marketInvestibleId = response.investible_id;
                    assert(response.quantity === 1000, 'investment quantity should be 1000');
                    return globalUserClient.markets.listCategories(globalMarketId);
                }).then((result) => {
                    return globalUserClient.investibles.listTemplates();
                }).then((result) => {
                    return globalUserClient.markets.listInvestiblePresences(globalMarketId);
                }).then((result) => {
                    return globalUserClient.markets.listTrending(globalMarketId, '2015-01-22T03:23:26Z');
                }).then((result) => {
                    return globalUserClient.markets.listUserInvestments(globalMarketId, userId, 5, 20);
                }).then((result) => {
                    return globalUserClient.markets.listInvestibles(globalMarketId, 'hello', 5, 20);
                }).then((result) => {
                    return globalUserClient.markets.listCategoriesInvestibles(globalMarketId, 'fish', 5, 20);
                }).then((result) => {
                    return globalUserClient.markets.listInvestibleInvestments(globalMarketId, marketInvestibleId, 5, 20, '2015-01-22T03:23:26Z');
                }).then((response) => {
                    //console.log('globalInvestibleId '+globalInvestibleId);
                    return globalUserClient.investibles.delete(globalInvestibleId);
                }).then((response) => {
                    //console.log('marketInvestibleId '+marketInvestibleId);
                    return globalClient.investibles.delete(marketInvestibleId);
                }).then((response) => {
                    return globalClient.markets.deleteMarket(globalMarketId);
                }).catch(function (error) {
                    console.log(error);
                });
            });
        });
    });
});

let _arrayEquals = (arr1, arr2) => {
    if(arr1.length !== arr2.length)
        return false;
    arr1.forEach(function (e) {
        if (arr2.indexOf(e) < 0)
            return false;
    });
    return true;
};

