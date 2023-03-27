import {loginUserToAccount} from "../src/utils";

module.exports = function (adminConfiguration) {
  describe('#demo specific actions', () => {
    it('can create a demo', async () => {
      const demoClient  = await loginUserToAccount(userConfiguration);
      console.dir(demoClient)
      const demoResults = await demoClient.demo.createDemo();
    }).timeout(1200000);
  });
};

