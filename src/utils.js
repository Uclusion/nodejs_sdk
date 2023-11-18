import { Auth } from 'aws-amplify';
import uclusion from 'uclusion_sdk';
import TestTokenManager, {TOKEN_TYPE_ACCOUNT, TOKEN_TYPE_MARKET, TOKEN_TYPE_MARKET_INVITE} from './TestTokenManager';
import {getIdentity} from './amplifyAuth';
import {WebSocketRunner} from './WebSocketRunner';


export function getSSOInfo(configuration) {
    // Cognito tokens are good for an hour and Cognito started objecting to repeated logins to switch users
    return uclusion.constructSSOClient(configuration)
    .then((ssoClient) => {
      return { idToken: configuration.idToken, ssoClient };
    });
}

export function getWebSocketRunner(configuration) {
    return loginUserToAccountAndGetToken(configuration)
        .then(response => {
            const { accountToken } = response;
            const webSocketRunner = new WebSocketRunner({ wsUrl: configuration.websocketURL,
                reconnectInterval: 3000});
            webSocketRunner.connect();
            webSocketRunner.subscribe(accountToken);
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
      const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient, idToken);
      return tokenManager.getToken()
        .then(() => uclusion.constructClient({ ...configuration, tokenManager }));
    });
}

export function loginUserToAccountAndGetToken(configuration) {
    return getSSOInfo(configuration)
        .then(info => {
            const { ssoClient, idToken } = info;
            const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, null, ssoClient,
                idToken);
            return tokenManager.getToken()
                .then((accountToken) => {
                    return uclusion.constructClient({ ...configuration, tokenManager })
                        .then((client) => {
                            return {accountToken, client};
                        })
                });
        });
}

export function getMessages(configuration) {
    return loginUserToAccountAndGetToken(configuration)
        .then(response => {
            const { accountToken } = response;
            return uclusion.constructSSOClient(configuration)
                .then((ssoClient) => {
                    return ssoClient.getMessages(accountToken);
                });
        });
}

export function loginUserToMarket(configuration, marketId) {
  return getSSOInfo(configuration)
    .then(info => {
      const { ssoClient, idToken } = info;
      const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, marketId, ssoClient, idToken);
      return tokenManager.getToken()
        .then(() => uclusion.constructClient({ ...configuration, tokenManager }));
    });
}

export function loginUserToMarketInvite(configuration, marketToken) {
    return getSSOInfo(configuration)
        .then(info => {
            const { ssoClient, idToken } = info;
            const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET_INVITE, marketToken, ssoClient,
                idToken);
            return tokenManager.getToken()
                .then(() => uclusion.constructClient({ ...configuration, tokenManager }));
        });
}