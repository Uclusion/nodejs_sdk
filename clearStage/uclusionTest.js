import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import awsAmplify from 'aws-amplify';
import identityTests from '../tests/identityTests.js';

const Amplify = awsAmplify.default;

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

const mattConfiguration = {
  baseURL:  'https://stage.api.uclusion.com/v1',
  websocketURL: 'wss://stage.ws.uclusion.com/v1',
  username: 'matt.ui@uclude.com',
  password: 'Uclusi0n_test',
};

describe('uclusion', () => {
  identityTests(adminConfiguration);
  identityTests(mattConfiguration);
});
