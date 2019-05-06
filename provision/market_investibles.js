import { loginUser } from "./login_utils";
import { sleep } from "../tests/commonTestFunctions";

export function createInvestibles(userEmail, marketId){
  let userClient = null;
  const clientPromise = loginUser(userEmail)
    .then((client) => {
      userClient = client;
      return userClient.users.get();
    }).then((user) => {
      return doInvestibleCreate(userClient, marketId, user.team_id);
    })
}

function doInvestibleCreate(userClient, marketId, teamId) {
  let promiseChain = new Promise((resolve, reject) => { resolve(true)});
  for (let i = 0; i < 100; i++) {
    promiseChain = promiseChain.then((result) => {
      console.log('Provisioning investible ' + i);
      return true;
    }).then((result) => {
      return userClient.investibles.create('Provisioning ' + i, 'To see if working for ' + i);
    }).then((response) => {
      return userClient.markets.investAndBind(marketId, teamId, response.id, 10,
        ['Category ' + (Math.floor(Math.random() * 10) + 1)]);
    }).then(() => {
      return sleep(1000);
    }).catch(function(error) {
      console.log(error);
      throw error;
    });
  }
  return promiseChain;
}
