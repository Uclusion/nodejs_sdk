import fetch from 'node-fetch';
global.fetch = fetch;

const adminConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    websocketURL: 'wss://dev.ws.uclusion.com/v1'
};

const userConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    websocketURL: 'wss://dev.ws.uclusion.com/v1'
};

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_NVPcNPhKS',
    clientId: '4knr08iqujrprrkpimqm04dnp',
    baseURL:  'https://dev.api.uclusion.com/v1',
};

const userAuthorizerConfiguration = {
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_NVPcNPhKS',
    clientId: '4knr08iqujrprrkpimqm04dnp',
    baseURL:  'https://dev.api.uclusion.com/v1',
};

describe('uclusion', () => {
    require('../tests/usersTest.js')(adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration);
    require('../tests/ssoTest.js')(adminConfiguration, adminAuthorizerConfiguration);
    require('../tests/marketsTest.js')(adminConfiguration);
    require('../tests/investiblesTest.js')(userConfiguration);
    require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, 4);
    require('../tests/listsTest.js')(adminConfiguration, userConfiguration);
});


