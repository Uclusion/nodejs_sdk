import {CognitoAuthorizer} from "../src/uclusion";

const adminAuthorizerConfiguration = {
    username: 'testeruclusion@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_A7IFY7Aow',
    clientId: '97v8rj9ibk9rv5thpncf01p1p'
};

const adminAuthorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);

const adminConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    authorizer: adminAuthorizer
};

const userAuthorizerConfiguration = {
    username: '827hooshang@gmail.com',
    password: 'Uclusi0n_test',
    poolId: 'us-west-2_A7IFY7Aow',
    clientId: '97v8rj9ibk9rv5thpncf01p1p'
};

const userAuthorizer = new CognitoAuthorizer(userAuthorizerConfiguration);

const userConfiguration = {
    baseURL:  'https://stage.api.uclusion.com/v1',
    authorizer: userAuthorizer
};

const adminUserId = '69967f7c-29e6-4abd-b03b-a6f074fea820';
const userId = '51627faa-95b3-471d-abef-22b70fafb148';

describe('uclusion', () => {
    require('../tests/usersTest.js')(adminConfiguration, adminUserId);
    require('../tests/marketsTest.js')(adminConfiguration, adminUserId);
    require('../tests/investiblesTest.js')(userConfiguration);
    require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, userId, 6);
    require('../tests/listsTest.js')(adminConfiguration, userConfiguration, userId);
});


