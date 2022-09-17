import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import Amplify from 'aws-amplify';

global.fetch = fetch;
global.AbortController = AbortController;

const cognitoConfiguration = {
  userPoolId: 'us-west-2_Mf87AlPbr',
  userPoolWebClientId: 'ntmrfr1h1qrm1u8vi47mo1bsu',
  region: 'us-west-2',
};

Amplify.configure({Auth: cognitoConfiguration});

const adminConfiguration = {
  baseURL:  'https://stage.api.uclusion.com/v1',
  websocketURL: 'wss://stage.ws.uclusion.com/v1',
  username: 'david.israel@uclude.com',
  password: 'Uclusi0n_test',
};

const userConfiguration = {
  baseURL:  'https://stage.api.uclusion.com/v1',
  websocketURL: 'wss://stage.ws.uclusion.com/v1',
  username: '827hooshang@gmail.com',
  password: 'Uclusi0n_test',
};

describe('uclusion', () => {
  require('../tests/identityTests.js')(adminConfiguration);
  require('../tests/usersTest.js')(adminConfiguration, userConfiguration);
  require('../tests/ssoTest.js')(adminConfiguration, userConfiguration);
  require('../tests/groupTest.js')(adminConfiguration, userConfiguration);
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
