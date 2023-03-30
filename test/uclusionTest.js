import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import Amplify from 'aws-amplify';


global.fetch = fetch;
global.AbortController = AbortController;

const stripeConfig = {
  public_api_key: 'pk_test_4Us5ZKn9MmEpVZNy35alXDof',
};

const cognitoConfiguration = {
  userPoolId: 'us-west-2_DF7pMdI6r',
  userPoolWebClientId: '375e3ronmppclr3onap4ndguvi',
  region: 'us-west-2',
};

Amplify.configure({ Auth: cognitoConfiguration });

const adminConfiguration = {
  baseURL: 'https://dev.api.uclusion.com/v1',
  websocketURL: 'wss://dev.ws.uclusion.com/v1',
  username: 'david.israel@uclude.com',
  password: 'Uclusi0n_test',
};

const userConfiguration = {
  baseURL: 'https://dev.api.uclusion.com/v1',
  websocketURL: 'wss://dev.ws.uclusion.com/v1',
  username: '827hooshang@gmail.com',
  password: 'Uclusi0n_test',
};


describe('uclusion', () => {
  require('../tests/identityTests.js')(adminConfiguration);
  require('../tests/usersTest.js')(adminConfiguration, userConfiguration);
  require('../tests/billingTest.js')(adminConfiguration, userConfiguration, stripeConfig);
//  require('../tests/demoTest.js')(adminConfiguration);
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


