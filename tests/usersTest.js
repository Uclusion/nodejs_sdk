import assert from 'assert'
import {uclusion} from "../src/uclusion";
import {CognitoAuthorizer, AnonymousAuthorizer} from "uclusion_authorizer_sdk";

module.exports = function(adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration) {
    describe('#doCreate account, teams and update user', () => {
        it('should login and pull without error', async () => {
            const authorizer = new AnonymousAuthorizer({
                uclusionUrl: adminConfiguration.baseURL,
            });
            let globalClient;
            const date = new Date();
            const timestamp = date.getTime();
            const accountName = 'TestAccount' + timestamp;
            await authorizer.cognitoAccountCreate({ accountName, name: 'Test Account',
                email: adminAuthorizerConfiguration.username }).then((response) => {
                adminAuthorizerConfiguration.accountId = response.account.id;
                userAuthorizerConfiguration.accountId = response.account.id;
                adminConfiguration.userId = response.user.id;
                adminConfiguration.authorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);
                // API key delay https://forums.aws.amazon.com/thread.jspa?threadID=298683&tstart=0
                return sleep(25000);
            }).then(() => {
                return uclusion.constructClient(adminConfiguration);
            }).then((client) => {
                globalClient = client;
                return client.users.update('Daniel');
            }).then((response) => {
                assert(response.success_message === 'User updated', 'User update was not successful');
                return globalClient.users.get(adminConfiguration.userId);
            }).then((user) => {
                assert(adminConfiguration.userId === user.id, 'Fetched user did not match me');
                assert(user.name === 'Daniel', 'Name not updated properly');
                return globalClient.users.update('Default');
            }).then((response) => {
                assert(response.success_message === 'User updated', 'Update not successful');
                return globalClient.teams.create('Test team', 'Holder for regular test user');
            }).then((team) => {
                return globalClient.users.create(team.id, 'Test User', userAuthorizerConfiguration.username);
            }).then((user) => {
                userConfiguration.userId = user.id;
                console.log('Investing User ID is ' + userConfiguration.userId);
                userConfiguration.authorizer = new CognitoAuthorizer(userAuthorizerConfiguration);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(60000);
    });
};

function sleep(ms){
    return new Promise(resolve=>{
        setTimeout(resolve,ms);
    })
}