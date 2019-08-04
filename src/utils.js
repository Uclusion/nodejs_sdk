import { Auth } from "aws-amplify";
import uclusion from "uclusion_sdk";
import TestTokenManager, { TOKEN_TYPE_ACCOUNT, TOKEN_TYPE_MARKET } from "./TestTokenManager";


function getSSOInfo(configuration) {
  return Auth.signIn(configuration)
    .then(() => Auth.currentSession())
    .then(cognitoData => cognitoData.idToken.jwtToken)
    .then(idToken => {
      console.log(`got new idtoken ${idToken}`);
      return uclusion.constructSSOClient(configuration)
        .then((ssoClient) => {
          return { idToken, ssoClient };
        });
    });
}

export function loginUserToAccount(configuration, accountId) {
  return getSSOInfo(configuration)
    .then(info => {
      const { ssoClient, idToken } = info;
      const tokenManager = new TestTokenManager(TOKEN_TYPE_ACCOUNT, accountId, ssoClient);
      return uclusion.constructClient({ ...configuration, tokenManager });
    });
}

export function loginUserToMarket(configuration, marketId) {
  return getSSOInfo(configuration)
    .then(info => {
      const { ssoClient, idToken } = info;
      const tokenManager = new TestTokenManager(TOKEN_TYPE_MARKET, marketId, ssoClient);
      return uclusion.constructClient({ ...configuration, tokenManager });
    });
}