import assert from 'assert'
import uclusion from 'uclusion_sdk';

module.exports = function(userConfiguration) {
    describe('#doCreateInvestible, ', () => {
        it('should create investible without error', async () => {
            let promise = uclusion.constructClient(userConfiguration);
            let globalClient;
            let globalInvestibleId;
            await promise.then((client) => {
                globalClient = client;
                return client.investibles.create('salmon', 'good on bagels');
            }).then((response) => {
                //console.log(response);
                globalInvestibleId = response.id;
                assert(response.name === 'salmon', 'name not passed on correctly');
                assert(response.description === 'good on bagels', 'description not passed on correctly');
                return globalClient.investibles.update(globalInvestibleId, 'tuna', 'good for sandwich');
            }).then((response) => {
                //console.log(response);
                assert(response.name === 'tuna', 'name not passed on correctly');
                assert(response.description === 'good for sandwich', 'description not passed on correctly');
                return globalClient.investibles.get(globalInvestibleId);
            }).then((investible) => {
                //console.log(investible);
                assert(investible.name === 'tuna', 'name not passed on correctly');
                assert(investible.description === 'good for sandwich', 'description not passed on correctly');
                return globalClient.investibles.delete(globalInvestibleId);
            }).catch(function(error) {
                console.log(error);
                throw error;
            });
        }).timeout(30000);
    });
};