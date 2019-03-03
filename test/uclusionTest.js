import fetch from 'node-fetch';
global.fetch = fetch;
import {
    CognitoAuthorizer,
} from 'uclusion_authorizer_sdk';

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_NVPcNPhKS',
    clientId: '4knr08iqujrprrkpimqm04dnp',
    baseURL:  'https://dev.api.uclusion.com/v1',
    accountId: '81d2b192-5cf2-4f49-83a2-cd83cca4a4f4'
};

const adminAuthorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);

const adminConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    authorizer: adminAuthorizer
};

const userAuthorizerConfiguration = {
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_NVPcNPhKS',
    clientId: '4knr08iqujrprrkpimqm04dnp',
    baseURL:  'https://dev.api.uclusion.com/v1',
    accountId: '81d2b192-5cf2-4f49-83a2-cd83cca4a4f4'
};

const userAuthorizer = new CognitoAuthorizer(userAuthorizerConfiguration);

const userConfiguration = {
    baseURL:  'https://dev.api.uclusion.com/v1',
    authorizer: userAuthorizer
};

const adminUserId = '969f6312-14a2-43f5-bc42-c78fa8679c46';
const userId = '537be585-4af7-4296-b062-2310bdac43ed';

describe('uclusion', () => {
    require('../tests/usersTest.js')(adminConfiguration, adminUserId);
    require('../tests/marketsTest.js')(adminConfiguration, adminUserId);
    require('../tests/investiblesTest.js')(userConfiguration);
    require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, userId, 4);
    require('../tests/listsTest.js')(adminConfiguration, userConfiguration, userId);
});


