import { Auth } from 'aws-amplify';
import uclusion from 'uclusion_sdk';
import TestTokenManager, { TOKEN_TYPE_ACCOUNT, TOKEN_TYPE_MARKET } from './TestTokenManager';
import {getIdentity} from './amplifyAuth';
import {WebSocketRunner} from './WebSocketRunner';


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

export function getWebSocketRunner(configuration) {
    return loginUserToIdentity(configuration)
        .then(idToken => {
            const webSocketRunner = new WebSocketRunner({ wsUrl: configuration.websocketURL, reconnectInterval: 3000});
            webSocketRunner.connect();
            webSocketRunner.subscribe(idToken);
            return webSocketRunner;
        });
}

export function loginUserToIdentity(configuration) {
    return Auth.signIn(configuration)
        .then(() => getIdentity());
}

export function loginUserToAccount(configuration) {
  return getSSOInfo(configuration)
    .then(info => {
      const { ssoClient, idToken } = info;
      const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient);
      return tokenManager.getToken()
        .then(() => uclusion.constructClient({ ...configuration, tokenManager }));
    });
}

export function loginUserWithToken(configuration, uclusionToken, marketId) {
    const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, marketId);
    tokenManager.setToken(uclusionToken);
    return uclusion.constructClient({ ...configuration, tokenManager });
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