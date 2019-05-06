import { loginUser } from "./login_utils";
import { sleep } from "../tests/commonTestFunctions";


export function createInvestibles(userEmail, marketId, numToMake){
  let userClient = null;
  const clientPromise = loginUser(userEmail)
    .then((client) => {
      userClient = client;
      return userClient.users.get();
    }).then((user) => {
      return doInvestiblesCreate(userClient, marketId, user.team_id, numToMake);
    });
  return clientPromise;
}

function doInvestiblesCreate(userClient, marketId, teamId, numToMake) {
  let promiseChain = new Promise((resolve, reject) => { resolve(true)});
  for (let i = 0; i < numToMake; i++) {
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

/** picks a random user from the userlist, and uses that user to pick
 * a random investible to invest with. THen invests 10 ushares into that investible
 * @param userList
 * @param marketId
 */
export function investRandomly(userList, marketId, numInvestments){
  let promiseChain = sleep(1000);
  for(let count = 0; count < numInvestments; count++){
    const userIndex = Math.floor(Math.random() * userList.length);
    const user = userList[userIndex];
    promiseChain = promiseChain.then(result => makeUserInvestInRandomInvestible(user, marketId));
  }
  return promiseChain;
}

function makeUserInvestInRandomInvestible(user, marketId){
  console.log("Logging in as user " + user + " to invest");
  const clientPromise = loginUser(user);
  let userClient = null;
  let teamId = null;
  return clientPromise.then((client) => {
    userClient = client;
    return userClient.users.get();
  }).then((user) => {
    teamId = user.team_id;
    return userClient.markets.listInvestibles(marketId);
  }).then((result) => {
    const { investibles } = result;
    const investibleIndex = Math.floor(Math.random() * investibles.length);
    const investible = investibles[investibleIndex];
    const { id } = investible;
    const quantity = Math.floor((Math.random() * 20)) + 1; //invest between 1 and 20 shares
    console.log("Investing in investible " + id + " for " + quantity.toString());
    return userClient.markets.createInvestment(marketId, teamId, id, quantity);
  });
}