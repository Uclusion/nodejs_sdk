import fetch from 'node-fetch';
import {AnonymousAuthorizer, CognitoAuthorizer} from "uclusion_authorizer_sdk";
import {uclusion} from "../src/uclusion";
global.fetch = fetch;

const adminConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    websocketURL: 'wss://dev.ws.uclusion.com/v1'
};

const cloneFromConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    websocketURL: 'wss://stage.ws.uclusion.com/v1'
};

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_NVPcNPhKS',
    clientId: '4knr08iqujrprrkpimqm04dnp',
    baseURL:  'https://dev.api.uclusion.com/v1',
};

const cloneFromAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_xNQkCChUO',
    clientId: '6umnmeui65283qk6mgciljktrl',
    baseURL:  'https://stage.api.uclusion.com/v1',
    accountId: 'b8a2297a-3ca2-4e35-8b0f-700d3187bf08'
};

function sleep(ms) {
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}

function createInvestibles(adminClient, marketId, cloneMarketClient, cloneMarketId) {
    const investiblesPromise = adminClient.markets.listInvestibles(marketId);
    return investiblesPromise.then((result) => {
        result.investibles.forEach((ibleObj) => {
            let toCopyInvestible;
            const investiblePromise = adminClient.markets.getMarketInvestibles(marketId, [ibleObj.id]);
            investiblePromise.then((investibles) => {
                toCopyInvestible = investibles[0];
                return cloneMarketClient.investibles.create(toCopyInvestible.name, toCopyInvestible.description);
            }).then((investible) => {
                return cloneMarketClient.investibles.bindToMarket(investible.id, cloneMarketId, toCopyInvestible.category_list);
            }).then(() => sleep(5000)).then( () => {
                console.log('.');
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        })
    })
}



const authorizer = new AnonymousAuthorizer({
    uclusionUrl: adminConfiguration.baseURL,
});

let globalClient;
let globalMarketId;
const date = new Date();
const timestamp = date.getTime();
const accountName = 'ProvisionedAccount' + timestamp;
authorizer.cognitoAccountCreate({ accountName, name: 'Clone Account',
    email: adminAuthorizerConfiguration.username }).then((response) => {
    adminAuthorizerConfiguration.accountId = response.account.id;
    console.log('Account is ' + response.account.id);
    adminConfiguration.userId = response.user.id;
    adminConfiguration.authorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);
    // API key delay https://forums.aws.amazon.com/thread.jspa?threadID=298683&tstart=0
    return sleep(25000);
}).then(() => {
    return uclusion.constructClient(adminConfiguration);
}).then((client) => {
    globalClient = client;
    return globalClient.markets.createMarket({name: 'Cloned Market', description: 'For UI testing', default_categories: true});
}).then((response) => {
    globalMarketId = response.market_id;
    console.log('Market ID is ' + globalMarketId);
    cloneFromConfiguration.authorizer = new CognitoAuthorizer(cloneFromAuthorizerConfiguration);
    return uclusion.constructClient(cloneFromConfiguration);
}).then((cloneFromClient) => {
    console.log('Creating investibles');
    return createInvestibles(cloneFromClient, '44147040-156d-4f60-b4c2-dcea7c2e9689', globalClient, globalMarketId);
}).catch(function(error) {
    console.log(error);
    throw error;
});