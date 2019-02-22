import assert from 'assert'
import {uclusion} from "../src/uclusion";

module.exports = function(adminConfiguration, adminUserId) {
    describe('#doLogin and update user', () => {
        it('should login and pull without error', async () => {
            let promise = uclusion.constructClient(adminConfiguration);
            let globalClient;
            await promise.then((client) => {
                globalClient = client;
                return client.users.update('Daniel');
            }).then((response) => {
                assert(response.success_message === 'User updated', 'User update was not successful');
                return globalClient.users.get(adminUserId);
            }).then((user) => {
                assert(adminUserId === user.id, 'Fetched user did not match me');
                assert(user.name === 'Daniel', 'Name not updated properly');
                return globalClient.users.update('Default');
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};