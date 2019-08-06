import { Auth } from 'aws-amplify';
import uclusion from 'uclusion_sdk';
import TestTokenManager, { TOKEN_TYPE_ACCOUNT, TOKEN_TYPE_MARKET } from './TestTokenManager';
import {getIdentity} from './amplifyAuth';


export function getSSOInfo(configuration) {
  return loginUserToIdentity(configuration)
    .then(idToken => {
//      console.log(`got new idtoken ${idToken}`);
      return uclusion.constructSSOClient(configuration)
        .then((ssoClient) => {
          return { idToken, ssoClient };
        });
    });
}

export function loginUserToIdentity(configuration) {
    return Auth.signIn(configuration)
        .then(getIdentity);
}

export function loginUserToAccount(configuration, accountId) {
  return getSSOInfo(configuration)
    .then(info => {
      const { ssoClient, idToken } = info;
      const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, accountId, ssoClient);
      return tokenManager.getToken()
        .then(() => uclusion.constructClient({ ...configuration, tokenManager }));
    });
}

export function loginUserToMarket(configuration, marketId) {
  return getSSOInfo(configuration)
    .then(info => {
      const { ssoClient, idToken } = info;
      const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, marketId, ssoClient);
      return tokenManager.getToken()
        .then(() => uclusion.constructClient({ ...configuration, tokenManager }));
    });
}