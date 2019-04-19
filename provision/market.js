import fetch from 'node-fetch';
import {AnonymousAuthorizer, CognitoAuthorizer} from "uclusion_authorizer_sdk";
import {uclusion} from "../src/uclusion";
global.fetch = fetch;

const adminConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    websocketURL: 'wss://stage.ws.uclusion.com/v1'
};

const userConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    websocketURL: 'wss://stage.ws.uclusion.com/v1'
};

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_xNQkCChUO',
    clientId: '6umnmeui65283qk6mgciljktrl',
    baseURL:  'https://stage.api.uclusion.com/v1',
};

const userAuthorizerConfiguration = {
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_xNQkCChUO',
    clientId: '6umnmeui65283qk6mgciljktrl',
    baseURL:  'https://stage.api.uclusion.com/v1',
};

function sleep(ms) {
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}

function createInvestibles(userClient, marketId, teamId) {
    let i;
    for (i = 0; i < 100; i++) {
        console.log('Provisioning investible ' + i);
        let promise = userClient.investibles.create('Provisioning ' + i,
            'To see if working for ' + i);
        promise.then((response) => {
            return userClient.markets.investAndBind(marketId, teamId, response.id, 10,
                ['Category ' + (Math.floor(Math.random() * 10) + 1)]);
        }).then(() => {
            return sleep(1500);
        }).catch(function(error) {
            console.log(error);
            throw error;
        });
    }
}

const authorizer = new AnonymousAuthorizer({
    uclusionUrl: adminConfiguration.baseURL,
});

let globalClient;
let globalUserClient;
let globalMarketId;
let globalInvestibleId;
let globalUserTeamId;
const date = new Date();
const timestamp = date.getTime();
const accountName = 'ProvisionedAccount' + timestamp;
authorizer.cognitoAccountCreate({ accountName, name: 'Test Account',
    email: adminAuthorizerConfiguration.username }).then((response) => {
    adminAuthorizerConfiguration.accountId = response.account.id;
    userAuthorizerConfiguration.accountId = response.account.id;
    console.log('Account is ' + response.account.id);
    adminConfiguration.userId = response.user.id;
    adminConfiguration.authorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);
    // API key delay https://forums.aws.amazon.com/thread.jspa?threadID=298683&tstart=0
    return sleep(25000);
}).then(() => {
    return uclusion.constructClient(adminConfiguration);
}).then((client) => {
    globalClient = client;
    return globalClient.teams.create('Provisioning team', 'Holder for regular provisioning user');
}).then((team) => {
    return globalClient.users.create(team.id, 'Provisioning User', userAuthorizerConfiguration.username);
}).then((user) => {
    userConfiguration.userId = user.id;
    console.log('Investing User ID is ' + userConfiguration.userId);
    userConfiguration.authorizer = new CognitoAuthorizer(userAuthorizerConfiguration);
    return globalClient.markets.createMarket({name: 'Provisioned Market', description: 'For UI testing'});
}).then((response) => {
    globalMarketId = response.market_id;
    console.log('Market ID is ' + globalMarketId);
    return uclusion.constructClient(userConfiguration);
}).then((client) => {
    globalUserClient = client;
    return globalUserClient.users.get(userConfiguration.userId);
}).then((response) => {
    globalUserTeamId = response.team_id;
    return globalClient.teams.bind(globalUserTeamId, globalMarketId);
}).then((response) => {
    return sleep(5000);
}).then((response) => {
    return globalClient.users.grant(userConfiguration.userId, globalMarketId, 9000);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 1', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 2', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 3', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 4', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 5', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 6', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 7', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 8', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 9', globalMarketId);
}).then((response) => {
    return globalClient.investibles.createCategory('Category 10', globalMarketId);
}).then(() => {
    return createInvestibles(globalUserClient, globalMarketId, globalUserTeamId);
}).catch(function(error) {
    console.log(error);
    throw error;
});