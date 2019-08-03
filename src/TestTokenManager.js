const TOKEN_TYPE_ACCOUNT = 'ACCOUNT';
const TOKEN_TYPE_MARKET = 'MARKET';
import { Auth } from 'aws-amplify';
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
    if(this.token) {
      return Promise.resolve(this.token);
    }
    return Auth.getCurrentSession()
      .then(tokenData => this.processTokenData(tokenData))
      .then((idToken) => {
        if(TOKEN_TYPE_MARKET === this.tokenType) {
          return ssoClient.marketCognitoLogin(idToken, this.itemId);
        }
        return ssoClient.accountCognitoLogin(idToken, this.itemId);
      })
      .then((newToken) => {
        this.token = newToken;
        return newToken;
      });
  }
}