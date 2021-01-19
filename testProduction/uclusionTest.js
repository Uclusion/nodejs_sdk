import fetch from 'node-fetch';
import Amplify from 'aws-amplify';
global.fetch = fetch;

const cognitoConfiguration = {
  userPoolId: 'us-west-2_tvPAGQR2e',
  userPoolWebClientId: '4dp5u64591fc43hbc2bcvodm9j',
  region: 'us-west-2',
};

Amplify.configure({Auth: cognitoConfiguration});

const adminConfiguration = {
  baseURL:  'https://production.api.uclusion.com/v1',
  websocketURL: 'wss://production.ws.uclusion.com/v1',
  username: 'sue.admin@uclude.com',
  password: 'Uclusi0n_test',
};

const userConfiguration = {
  baseURL:  'https://production.api.uclusion.com/v1',
  websocketURL: 'wss://production.ws.uclusion.com/v1',
  username: 'jim.user@uclude.com',
  password: 'Uclusi0n_test',
};

describe('uclusion', () => {
  require('../tests/identityTests.js')(adminConfiguration);
  require('../tests/usersTest.js')(adminConfiguration, userConfiguration);
  require('../tests/ssoTest.js')(adminConfiguration, userConfiguration);
  require('../tests/inlineNotificationsTest.js')(adminConfiguration, userConfiguration);
  require('../tests/storyNotificationsTest.js')(adminConfiguration, userConfiguration);
  require('../tests/initiativeNotificationsTest.js')(adminConfiguration, userConfiguration);
  require('../tests/decisionNotificationsTest.js')(adminConfiguration, userConfiguration);
  require('../tests/securityTests.js')(adminConfiguration, userConfiguration);
  require('../tests/marketsTest.js')(adminConfiguration, userConfiguration);
  require('../tests/planningTest.js')(adminConfiguration, userConfiguration);
  require('../tests/marketInvestiblesTest')(adminConfiguration, userConfiguration);
  require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, 2);
  require('../tests/listsTest.js')(adminConfiguration, userConfiguration);
});
