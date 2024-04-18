import assert from 'assert';
import {getMessages, loginUserToAccount, loginUserToMarketInvite} from "../src/utils";

module.exports = function (adminConfiguration, userConfiguration) {
  describe('#group specific actions', () => {
    it('addressing an investible should work', async () => {
      let adminClient;
      let userClient;
      let adminUserId;
      let userId;
      let externalId;
      let adminExternalId;
      let marketId;
      let marketCapability;
      let globalGroupId;
      let marketInvestibleId;
      const promise = loginUserToAccount(adminConfiguration);
      await promise.then((client) => {
        const planningMarket = {
          name: 'Company B',
          market_type: 'PLANNING'
        };
        return client.markets.createMarket(planningMarket);
      }).then((result) => {
        marketId = result.market.id;
        marketCapability = result.market.invite_capability;
        assert(result.market.name === 'Company B', 'Market created with wrong name');
        return loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      }).then((client) => {
        adminClient = client;
        return client.users.get();
      }).then((me) => {
        adminUserId = me.id;
        adminExternalId = me.external_id;
        return adminClient.markets.lock(marketId);
      }).then((group) => {
        assert(group.locked_by === adminUserId, 'Lock failed');
        return adminClient.markets.updateGroup(marketId,
            {name: 'Company A', description: 'See if can change description'});
      }).then((group) => {
        assert(group.name === 'Company A', 'Group name returned incorrectly');
        assert(group.description === 'See if can change description', 'Description returned incorrectly');
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'group',
          object_id: marketId});
      }).then(() => {
        return adminClient.markets.createGroup({name: 'Team A', description: 'Group for team A.'})
      }).then((response) => {
        const { group } = response;
        globalGroupId = group.id;
        assert(group.description === 'Group for team A.', 'Description returned incorrectly');
        assert(group.name === 'Team A', 'Group name returned incorrectly');
        return adminConfiguration.webSocketRunner.waitForReceivedMessages([
            {event_type: 'group', object_id: marketId}, {event_type: 'group_capability', object_id: marketId}]);
      }).then(() => {
        return adminClient.markets.listGroups();
      }).then((groups) => {
        groups.forEach((group) => {
          if (group.id === globalGroupId) {
            assert(group.name === 'Team A', 'Team A wrong name');
            assert(group.description === 'Group for team A.', 'Team A wrong description');
          } else {
            assert(group.name === 'Company A', 'Company A wrong name');
            assert(group.description === 'See if can change description', 'Company A wrong description');
          }
        });
        return adminClient.markets.listGroupMembers(globalGroupId);
      }).then((members) => {
        assert(members.length === 1, 'Team A wrong size');
        assert(members.find((member) => member.id === adminUserId), 'Team A wrong members');
        return adminClient.investibles.create({name: 'salmon spawning', description: 'plan to catch',
          groupId: globalGroupId, openForInvestment: true});
      }).then((investible) => {
        marketInvestibleId = investible.investible.id;
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible',
          object_id: marketId});
      }).then(() => {
        return loginUserToMarketInvite(userConfiguration, marketCapability);
      }).then((client) => {
        userClient = client;
        return client.users.get();
      }).then((me) => {
        userId = me.id;
        externalId = me.external_id;
        return userClient.investibles.follow(marketInvestibleId, [{user_id: userId, is_following: true}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage(
          {event_type: 'investment', object_id: marketId});
      }).then(() => {
        return userClient.markets.listUsers();
      }).then((users) => {
        const addressed = users.filter((user) => user.investments && user.investments.length === 1);
        assert(addressed.length === 1 && addressed[0].id === userId, 'Investments should only includes added user');
        const investments = addressed[0].investments;
        assert(investments.length === 1, 'Should be only one investment.');
        const investment = investments[0];
        assert(investment.abstain === false && investment.investible_id === marketInvestibleId,
            'Addressed should be for created investible and not abstained');
        return userClient.investibles.follow(marketInvestibleId, [{user_id: userId, is_following: false}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage(
            {event_type: 'investment', object_id: marketId});
      }).then(() => {
        return userClient.markets.listUsers();
      }).then((users) => {
        const addressed = users.filter((user) => user.investments && user.investments.length === 1);
        assert(addressed.length === 1 && addressed[0].id === userId, 'Investments should only includes added user');
        const investments = addressed[0].investments;
        assert(investments.length === 1, 'Should be only one investment.');
        const investment = investments[0];
        assert(investment.abstain === true && investment.investible_id === marketInvestibleId,
            'Addressed should be for created investible and abstained');
        return userClient.markets.followGroup(globalGroupId, [{user_id: userId, is_following: true}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage(
          {event_type: 'group_capability', object_id: marketId});
      }).then(() => {
        return adminClient.markets.listGroupMembers(globalGroupId);
      }).then((members) => {
        assert(members.length === 2, 'Team A wrong size');
        assert(members.find((member) => member.id === userId), 'Team A wrong members');
        return userClient.markets.followGroup(globalGroupId, [{user_id: userId, is_following: false}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage(
            {event_type: 'group_capability', object_id: marketId});
      }).then(() => {
        return adminClient.markets.listGroupMembers([globalGroupId]);
      }).then((members) => {
        assert(members.find((member) => member.id === userId && member.deleted), 'Team A wrong members');
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(1200000);
  });
};

