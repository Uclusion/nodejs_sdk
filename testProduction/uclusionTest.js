import fetch from 'node-fetch';
import Amplify from 'aws-amplify';
global.fetch = fetch;

const cognitoConfiguration = {
  userPoolId: 'us-west-2_tvPAGQR2e',
  userPoolWebClientId: '3uudu732sp3m31h8n0easmr7h1',
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
  require('../tests/marketsTest.js')(adminConfiguration, userConfiguration);
  require('../tests/marketInvestiblesTest')(adminConfiguration, userConfiguration);
  require('../tests/investmentsTest.js')(adminConfiguration, userConfiguration, 2);
  require('../tests/listsTest.js')(adminConfiguration, userConfiguration);
});
