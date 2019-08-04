import { Auth } from 'aws-amplify';
import jwt_decode from 'jwt-decode';
import uclusion from 'uclusion_sdk';

export const TOKEN_TYPE_ACCOUNT = 'ACCOUNT';
export const TOKEN_TYPE_MARKET = 'MARKET';

class TestTokenManager{

  constructor(tokenType, itemId, ssoClient) {
    this.tokenType = tokenType;
    this.itemId = itemId;
    this.ssoClient = ssoClient;
    this.token = null;
  }

  processTokenData(tokenData){
    const { idToken } = tokenData;
    const { jwtToken } = idToken;
    return jwtToken;
  }

  getToken() {
    console.log(`got asked for token of type ${this.tokenType} for item id ${this.itemId}`);
    if(this.token) {
      console.log(`using existing token ${this.token}`);
      return Promise.resolve(this.token);
    }
    return Auth.currentSession()
      .then(tokenData => this.processTokenData(tokenData))
      .then((idToken) => {
        if(TOKEN_TYPE_MARKET === this.tokenType) {
          return this.ssoClient.marketCognitoLogin(idToken, this.itemId);
        }
        return this.ssoClient.accountCognitoLogin(idToken, this.itemId);
      })
      .then((loginData) => {
        console.log(loginData);
        const { uclusion_token } = loginData;
        this.token = uclusion_token;
        return Promise.resolve(this.token);
      });
  }
}

export default TestTokenManager;