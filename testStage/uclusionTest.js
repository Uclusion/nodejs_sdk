import fetch from 'node-fetch';
global.fetch = fetch;
import {
    CognitoAuthorizer,
} from 'uclusion_authorizer_sdk';

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_xNQkCChUO',
    clientId: '6umnmeui65283qk6mgciljktrl',
    baseURL:  'https://stage.api.uclusion.com/v1',
    accountId: 'fb5fdb9b-203e-4260-8d24-b66d0317ff13'
};

const adminAuthorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);

const adminConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    authorizer: adminAuthorizer,
    websocketURL: 'wss://dev.ws.uclusion.com/v1'
};

const userAuthorizerConfiguration = {
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_xNQkCChUO',
    clientId: '6umnmeui65283qk6mgciljktrl',
    baseURL:  'https://stage.api.uclusion.com/v1',
    accountId: 'fb5fdb9b-203e-4260-8d24-b66d0317ff13'
};

const userAuthorizer = new CognitoAuthorizer(userAuthorizerConfiguration);

const userConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    authorizer: userAuthorizer
};

const adminUserId = '2976a8ed-eac9-4d20-8ab6-91b3b6e01dd3';
const userId = '70a638ce-1ca9-47e7-b49a-6d193d147370';

describe('uclusion', () => {
    require('../tests/usersTest.js')(adminConfiguration, adminUserId);
    require('../tests/marketsTest.js')(adminConfiguration, adminUserId);
    require('../tests/investiblesTest.js')(userConfiguration);
    require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, userId, 4);
    require('../tests/listsTest.js')(adminConfiguration, userConfiguration, userId);
});


