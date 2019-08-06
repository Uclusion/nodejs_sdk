/**
 * This is a simple wrapper around the amplify session to avoid code repetition
 */
import { Auth } from 'aws-amplify';

export function getIdentity() {
    return Auth.currentSession().then((sessionData) => {
      const { idToken } = sessionData;
      const { jwtToken } = idToken;
      // console.debug(jwt_decode(jwtToken));
      return jwtToken;
    });
}
