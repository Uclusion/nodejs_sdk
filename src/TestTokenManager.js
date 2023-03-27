import { getIdentity } from './amplifyAuth';

    export const TOKEN_TYPE_ACCOUNT = 'ACCOUNT';
    export const TOKEN_TYPE_MARKET = 'MARKET';
    export const TOKEN_TYPE_MARKET_INVITE = 'MARKET_INVITE';

    class TestTokenManager{

      constructor(tokenType, itemId, ssoClient) {
        this.tokenType = tokenType;
        this.itemId = itemId;
        this.ssoClient = ssoClient;
        this.token = null;
      }

      getToken() {
       // console.log(`got asked for token of type ${this.tokenType} for item id ${this.itemId}`);
        if(this.token) {
       //   console.log(`using existing token ${this.token}`);
          return Promise.resolve(this.token);
        }
        return getIdentity()
          .then((idToken) => {
            if (TOKEN_TYPE_MARKET === this.tokenType) {
              return this.ssoClient.marketCognitoLogin(idToken, this.itemId);
            }
            if (TOKEN_TYPE_MARKET_INVITE === this.tokenType) {
              return this.ssoClient.marketInviteLogin(idToken, this.itemId);
            }
            return this.ssoClient.accountCognitoLogin(idToken);
          })
          .then((loginData) => {
       //     console.log(loginData);
            const { uclusion_token } = loginData;
            this.token = uclusion_token;
            return Promise.resolve(this.token);
          });
      }

      setToken(uclusionToken) {
        this.token = uclusionToken;
      }
    }

export default TestTokenManager;