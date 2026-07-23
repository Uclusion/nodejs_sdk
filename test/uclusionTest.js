import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import awsAmplify from 'aws-amplify';
import identityTests from '../tests/identityTests.js';
import usersTest from '../tests/usersTest.js';
import billingTest from '../tests/billingTest.js';
import ssoTest from '../tests/ssoTest.js';
import groupTest from '../tests/groupTest.js';
import inlineNotificationsTest from '../tests/inlineNotificationsTest.js';
import storyNotificationsTest from '../tests/storyNotificationsTest.js';
import initiativeNotificationsTest from '../tests/initiativeNotificationsTest.js';
import decisionNotificationsTest from '../tests/decisionNotificationsTest.js';
import securityTests from '../tests/securityTests.js';
import marketsTest from '../tests/marketsTest.js';
import planningTest from '../tests/planningTest.js';
import conversionsTest from '../tests/conversionsTest.js';
import resolveNotificationsTest from '../tests/resolveNotificationsTest.js';
import mcpVotingTest from '../tests/mcpVotingTest.js';
import aiPokeTest from '../tests/aiPokeTest.js';
import marketInvestiblesTest from '../tests/marketInvestiblesTest.js';
import investmentsTest from '../tests/investmentsTest.js';
import listsTest from '../tests/listsTest.js';

const Amplify = awsAmplify.default;

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
  identityTests(adminConfiguration);
  usersTest(adminConfiguration, userConfiguration);
  billingTest(adminConfiguration, userConfiguration, stripeConfig);
  ssoTest(adminConfiguration, userConfiguration);
  groupTest(adminConfiguration, userConfiguration);
  inlineNotificationsTest(adminConfiguration, userConfiguration);
  storyNotificationsTest(adminConfiguration, userConfiguration);
  initiativeNotificationsTest(adminConfiguration, userConfiguration);
  decisionNotificationsTest(adminConfiguration, userConfiguration);
  securityTests(adminConfiguration, userConfiguration);
  marketsTest(adminConfiguration, userConfiguration);
  planningTest(adminConfiguration, userConfiguration);
  conversionsTest(adminConfiguration);
  resolveNotificationsTest(adminConfiguration, userConfiguration);
  mcpVotingTest(adminConfiguration, userConfiguration);
  aiPokeTest(adminConfiguration);
  marketInvestiblesTest(adminConfiguration, userConfiguration);
  investmentsTest(adminConfiguration, userConfiguration, 2);
  listsTest(adminConfiguration, userConfiguration);
});
