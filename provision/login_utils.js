import { CognitoAuthorizer } from "uclusion_authorizer_sdk";
import uclusion from "uclusion_sdk";


const adminConfiguration = {
  baseURL:  'https://stage.api.uclusion.com/v1',
  websocketURL: 'wss://stage.ws.uclusion.com/v1'
};

const userConfiguration = {
  baseURL:  'https://stage.api.uclusion.com/v1',
  websocketURL: 'wss://stage.ws.uclusion.com/v1'
};

const adminAuthorizerConfiguration = {
  username: 'testeruclusion@gmail.com',
  password: 'Uclusi0n_test',
  poolId: 'us-west-2_xNQkCChUO',
  clientId: '6umnmeui65283qk6mgciljktrl',
  baseURL:  'https://stage.api.uclusion.com/v1',
};

const userAuthorizerConfiguration = {
  username: '827hooshang@gmail.com',
  password: 'Uclusi0n_test',
  poolId: 'us-west-2_xNQkCChUO',
  clientId: '6umnmeui65283qk6mgciljktrl',
  baseURL:  'https://stage.api.uclusion.com/v1',
};

export { adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration };

export function loginUser(userEmail){
  const clientConfig = {...userConfiguration};
  const authorizerConfig = {...userAuthorizerConfiguration};
  authorizerConfig.username = userEmail;
  clientConfig.authorizer = new CognitoAuthorizer(authorizerConfig);
  return uclusion.constructClient(clientConfig);
}
