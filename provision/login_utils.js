import { CognitoAuthorizer } from "uclusion_authorizer_sdk";
import uclusion from "uclusion_sdk";


export const adminConfiguration = {
  baseURL:  'https://dev.api.uclusion.com/v1',
  websocketURL: 'wss://dev.ws.uclusion.com/v1'
};

export const userConfiguration = {
  baseURL:  'https://dev.api.uclusion.com/v1',
  websocketURL: 'wss://dev.ws.uclusion.com/v1'
};

export const adminAuthorizerConfiguration = {
  username: 'testeruclusion@gmail.com',
  password: 'Uclusi0n_test',
  poolId: 'us-west-2_NVPcNPhKS',
  clientId: '4knr08iqujrprrkpimqm04dnp',
  baseURL:  'https://dev.api.uclusion.com/v1',
};

export const userAuthorizerConfiguration = {
  username: '827hooshang@gmail.com',
  password: 'Uclusi0n_test',
  poolId: 'us-west-2_NVPcNPhKS',
  clientId: '4knr08iqujrprrkpimqm04dnp',
  baseURL:  'https://dev.api.uclusion.com/v1',
};


export function loginUser(userEmail){
  const clientConfig = {...userConfiguration};
  const authorizerConfig = {...userAuthorizerConfiguration};
  authorizerConfig.username = userEmail;
  clientConfig.authorizer = new CognitoAuthorizer(authorizerConfig);
  return uclusion.constructClient(clientConfig);
}
