import { sleep } from "../tests/commonTestFunctions";

const numUsers = 1;
const medianSize = 5;
const fixedAllocations = [1]; //[1, 5, 10, 15]; // 31 users reserved for fixed distribution

const baseUserPattern = 'tuser+[id]@uclusion.com';

export function getUserList(){
  const users = [];
  for(let i = 0; i < numUsers; i++){
    users.push(getUserEmail(i));
  }
  return users;
}

function getUserEmail(id){
  return baseUserPattern.replace('[id]', id.toString());
}


function createBucket(allocation, firstAvailableId) {
  const bucket = [];
  for (let i = firstAvailableId; i < allocation + firstAvailableId; i++) {
    bucket.push(getUserEmail(i));
  }
  return bucket;
}

function bucketizeUsers() {
  const buckets = [];
  let i = 0;
  //first create all the fixed allocations
  fixedAllocations.forEach((allocation) => {
    buckets.push(createBucket(allocation, i));
    i += allocation;
  });
  while (i < numUsers) {
    //now randomly create stuff with a distribution centered on 5 (eg, rand 1 to 10)
    let randSize = (Math.random() * 10) + 1;
    if ((randSize + i) >= numUsers) {
      randSize = numUsers - i;
    }
    buckets.push(createBucket(randSize, i));
    i += randSize;
  }
  return buckets;
}

export function createMarketTeams(client, marketId) {
  const teamUsers = bucketizeUsers();
  let teamIndex = 0;
  let promiseChain = new Promise((resolve, reject) => resolve(true));
  teamUsers.forEach((userList) => {
    const teamName = `Team ${teamIndex}`;
    const teamDescription = 'For testing display of more teams';
    teamIndex += 1;
    let teamId = null;
    promiseChain = promiseChain.then((result) => {
      return client.teams.create(teamName, teamDescription)
    }).then((team) => {
          teamId = team.id;
          client.teams.bind(teamId, marketId);
    }).then((response) => { return true;});
    userList.forEach((user) => {
      console.log("Creating user " + user);
      const lastName = user.replace('@uclusion.com', '');
      const name = `User ${lastName}`;
      promiseChain = promiseChain.then(result => sleep(1000)).then(result=> client.users.create(teamId, name, user));
    });
  });
  return promiseChain;
}