import {CognitoAuthorizer} from "../src/uclusion";

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

const adminUserId = '03e134fb-44bc-42d2-a499-316f7260da35';
const userId = '0404c4f1-600a-4788-ac8d-f5556ae2e573';

describe('uclusion', () => {
    require('../tests/usersTest.js')(adminConfiguration, adminUserId);
    require('../tests/marketsTest.js')(adminConfiguration, adminUserId);
    require('../tests/investiblesTest.js')(userConfiguration);
    require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, userId);
    require('../tests/listsTest.js')(adminConfiguration, userConfiguration, userId);
});


