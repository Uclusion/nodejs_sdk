import fetch from 'node-fetch';
import Amplify from 'aws-amplify';
global.fetch = fetch;

const cognitoConfiguration = {
    userPoolId: 'us-west-2_NVPcNPhKS',
    userPoolWebClientId: '4knr08iqujrprrkpimqm04dnp',
    region: 'us-west-2',
};

Amplify.configure({Auth: cognitoConfiguration});

const adminConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    websocketURL: 'wss://dev.ws.uclusion.com/v1',
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
};

const userConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    websocketURL: 'wss://dev.ws.uclusion.com/v1',
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
};




describe('uclusion', () => {
    require('../tests/usersTest.js')(adminConfiguration, userConfiguration);
    require('../tests/ssoTest.js')(adminConfiguration, userConfiguration);
    require('../tests/marketsTest.js')(adminConfiguration);
    require('../tests/marketInvestiblesTest')(adminConfiguration);
    require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, 2);
    require('../tests/listsTest.js')(adminConfiguration, userConfiguration);
});


