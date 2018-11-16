import fetch from 'node-fetch';
global.fetch = fetch;
import { CognitoUserPool, CognitoUserAttribute, CognitoUser, AuthenticationDetails } from 'amazon-cognito-identity-js';

export function CognitoAuthorizer(configuration){

    /**
     * Initializes the congnito user system with the given pool ID and client id.
     * With the initialized pool you can authenticate your user, and then pass the
     * user authenticated user's token innto constructClient
     * @param poolId the id of the pool you want to connect to
     * @param clientId your client id for the pool
     * @returns {AmazonCognitoIdentity.CognitoUserPool} a configured cognito user pool
     */
    let initializeCognito = (poolId, clientId) => {
        const poolData = {UserPoolId: poolId, ClientId: clientId};
        let userPool = new CognitoUserPool(poolData);
        return userPool;
    };

    /**
     * Given a pool, username and password, attempts to log the user in
     * to the pool, with the username and password
     * @param cognitoPool the pool we are connecting to
     * @param username the username of the user we're authenticating
     * @param password the password of the user we're authenticating
     * @returns A Promise that will pass in the authentication result to resolve or reject
     */
    let authenticateUser = (cognitoPool, username, password) => {
        return new Promise((resolve, reject) =>
        {
            const authenticationData = {
                Username: username,
                Password: password
            };
            const authenticationDetails = new AuthenticationDetails(authenticationData);
            const userData = {
                Username: username,
                Pool: cognitoPool
            };
            const cognitoUser = new CognitoUser(userData);
            cognitoUser.authenticateUser(authenticationDetails, {
                onSuccess: (result) => { resolve(result) },
                onFailure: (error) => { reject(error) },
                newPasswordRequired: (userAttribute, requiredAttributes) => { reject({ newPasswordRequired: true, userAttribute: userAttribute, requiredAttributes: requiredAttributes }) }
            });
        });
    };


    /**
     * An object which will authorize the user and return a promise which resolves to the authorization token
     * @param resolve the function to call when the authorizaton token is ready
     * @param reject the function to call when authorization fails
     * @returns {PromiseLike<T>} a promise which will resolve to the authorization token
     */
    this.authorize = (resolve, reject) => {
        const cognitoPool = initializeCognito(configuration.poolId, configuration.clientId);
        const promise = authenticateUser(cognitoPool, configuration.username, configuration.password);
        return promise.then((result) => {
            const currentUser = cognitoPool.getCurrentUser();
            const sessionPromise = new Promise((resolve, reject) => {
              currentUser.getSession((err, session) => {
                if(err){
                  reject(err);
                }
                resolve(session);
              });
            });
            return sessionPromise;
          }).then((session) => {
              const token = session.getIdToken().getJwtToken();
              //console.log("My token:" + token);
              return token
            });
    };CognitoAuthorizer

    /**
     * Simple reauthorizer that just calls authorize again
     * @param resolve the function to call when the auth token is ready
     * @param reject the function to call when authorization fails
     * @returns {*}
     */
    this.reauthorize = (resolve, reject) => {
        return this.authorize(resolve, reject);
    }
}
