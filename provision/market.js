import fetch from 'node-fetch';
import {AnonymousAuthorizer, CognitoAuthorizer} from "uclusion_authorizer_sdk";
import {uclusion} from "../src/uclusion";
import { createMarketTeams } from "./market_users";
import { createInvestibles } from "./market_investibles";
import {
    adminAuthorizerConfiguration, userAuthorizerConfiguration,
    userConfiguration, adminConfiguration,
    loginUser
} from "./login_utils";

global.fetch = fetch;


function sleep(ms) {
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}

function investInInvestible(userEmail, marketId, investibleId, quantity){
    const clientPromise = loginUser(userEmail);
    let userClient = null;
    return clientPromise.then((client) => {
        userClient = client;
        return userClient.users.get();
    }).then((user) => {
        userClient.markets.createInvestment(marketId, investibleId, user.team_id, quantity);
    });
}

const authorizer = new AnonymousAuthorizer({
    uclusionUrl: adminConfiguration.baseURL,
});

let globalClient;
let globalUserClient;
let globalMarketId;
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
}).then((repsponse) => {
    return createMarketTeams(globalClient, globalMarketId);
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
    return createInvestibles('827hooshang@gmail.com', globalMarketId);
}).catch(function(error) {
    console.log(error);
    throw error;
});