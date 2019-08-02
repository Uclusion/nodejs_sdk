import assert from 'assert';
import uclusion from 'uclusion_sdk';
import { CognitoAuthorizer } from "uclusion_authorizer_sdk";


module.exports = function (adminConfiguration, userConfiguration, adminAuthorizerConfiguration, userAuthorizerConfiguration) {
  describe('#doCreate account and update user', () => {
    it('should login and pull without error', async () => {
      adminConfiguration.authorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);
      let globalClient;
      const date = new Date();
      const timestamp = date.getTime();
      const accountName = 'TestAccount' + timestamp;
      let globalIdToken;
      await uclusion.constructClient(adminConfiguration)
          .then((client) => {
            globalIdToken = adminConfiguration.authorizer.cognitoToken;
            return uclusion.constructSSOClient(adminConfiguration);
          }).then(client => client.cognitoAccountCreate(accountName, globalIdToken, 'Advanced', true))
        .then((response) => {
          adminAuthorizerConfiguration.accountId = response.account.id;
          userAuthorizerConfiguration.accountId = response.account.id;
          adminConfiguration.userId = response.user.id;
          adminConfiguration.authorizer = new CognitoAuthorizer(adminAuthorizerConfiguration);
          // API key delay https://forums.aws.amazon.com/thread.jspa?threadID=298683&tstart=0
          return sleep(30000);
        }).then(() => {
          return uclusion.constructClient(adminConfiguration);
        }).then((client) => {
          globalClient = client;
          return client.users.update('Daniel', '{ "code": "red" }');
        }).then((response) => {
          assert(response.success_message === 'User updated', 'User update was not successful');
          return globalClient.users.get(adminConfiguration.userId);
        }).then((user) => {
          assert(adminConfiguration.userId === user.id, 'Fetched user did not match me');
          assert(user.name === 'Daniel', 'Name not updated properly');
          assert(user.ui_preferences === '{ "code": "red" }', 'UI preferences not updated properly');
          return globalClient.users.update('Default');
        }).then((response) => {
          assert(response.success_message === 'User updated', 'Update not successful');
        }).catch(function (error) {
          console.log(error);
          throw error;
        });
    }).timeout(60000);
  });
};

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}