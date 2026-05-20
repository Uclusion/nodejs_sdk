import fetch from 'node-fetch';
import awsAmplify from 'aws-amplify';
import identityTests from '../tests/identityTests.js';
import usersTest from '../tests/usersTest.js';
import ssoTest from '../tests/ssoTest.js';
import groupTest from '../tests/groupTest.js';
import inlineNotificationsTest from '../tests/inlineNotificationsTest.js';
import storyNotificationsTest from '../tests/storyNotificationsTest.js';
import initiativeNotificationsTest from '../tests/initiativeNotificationsTest.js';
import decisionNotificationsTest from '../tests/decisionNotificationsTest.js';
import securityTests from '../tests/securityTests.js';
import marketsTest from '../tests/marketsTest.js';
import planningTest from '../tests/planningTest.js';
import marketInvestiblesTest from '../tests/marketInvestiblesTest.js';
import investmentsTest from '../tests/investmentsTest.js';
import listsTest from '../tests/listsTest.js';

const Amplify = awsAmplify.default;

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
  identityTests(adminConfiguration);
  usersTest(adminConfiguration, userConfiguration);
  ssoTest(adminConfiguration, userConfiguration);
  groupTest(adminConfiguration, userConfiguration);
  inlineNotificationsTest(adminConfiguration, userConfiguration);
  storyNotificationsTest(adminConfiguration, userConfiguration);
  initiativeNotificationsTest(adminConfiguration, userConfiguration);
  decisionNotificationsTest(adminConfiguration, userConfiguration);
  securityTests(adminConfiguration, userConfiguration);
  marketsTest(adminConfiguration, userConfiguration);
  planningTest(adminConfiguration, userConfiguration);
  marketInvestiblesTest(adminConfiguration, userConfiguration);
  investmentsTest(adminConfiguration, userConfiguration, 2);
  listsTest(adminConfiguration, userConfiguration);
});
