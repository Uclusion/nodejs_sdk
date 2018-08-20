//hack around amazon not having fetch, and running in node and EC6 env
/*if(global){
    import fetch from 'node-fetch';
    global.fetch = fetch;
}*/
//const AmazonCognitoIdentity = require('amazon-cognito-identity-js');
import { CognitoUserPool, CognitoUserAttribute, CognitoUser, AuthenticationDetails } from 'amazon-cognito-identity-js';
//const CognitoUserPool = AmazonCognitoIdentity.CognitoUserPool;

import a_users from './components/users.js';
import a_markets from './components/markets.js';
import a_investibles from './components/investibles.js';
import a_client from './components/fetchClient.js';

function Uclusion() {

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
     * Constructs an api client from a given base endpoint url and a user token gotten from cognito
     * @param apiBaseUrl the base url of the API endpoint
     * @param authorizer an object that when authorizer.authorize() is called returns the authorization toen
     * @returns an instantiated api client.
     */
    this.setupClient = (apiBaseUrl, authorizer) => {
        let transportClient = a_client({baseURL: apiBaseUrl});
        return authorizer.authorize((result) => {
            transportClient.setAuthorization(userToken);
            let apiClient = {
                users: a_users(transportClient),
                markets: a_markets(transportClient),
                investibles: a_investibles(transportClient)
            };
            // console.log(apiClient.user);
            return apiClient;
        });
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
     * Constructs a cognito client according to the configuration passed in.
     * @param configuration, an object with a poolId, clientId, username, password, and baseURL set
     * @returns {PromiseLike<an> | Promise<an>} A promise that when resolved will return a fully instantiated client

    this.constructClient = (configuration) => {
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
              return setupClient(configuration.baseURL, token);
            });

    };
     */
    /**
     * Constructs a client that has been pre-authorized by an identity provider the configuration.baseURL endpoint will accept, and contains an authorizer that can authorize the client
     * @param configuration an object with a baseURL and authorizationToken parameter set.
     * @returns A promise that when resolved will be a fully instantiated client
     */
    this.constructClient = (configuration) => {
        return setupClient(configuration);
    };
}

let uclusion = new Uclusion();
export default uclusion;
