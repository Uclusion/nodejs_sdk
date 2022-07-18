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
      let storyId;
      let marketCapability;
      let publicGroupId;
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
        publicGroupId = result.group.id;
        assert(result.group.name === 'Company B', 'Group created with wrong name');
        return loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      }).then((client) => {
        adminClient = client;
        return client.users.get();
      }).then((me) => {
        adminUserId = me.id;
        adminExternalId = me.external_id;
        return adminClient.markets.lock(publicGroupId);
      }).then((group) => {
        assert(group.locked_by === adminUserId, 'Lock failed');
        return adminClient.markets.updateGroup(publicGroupId, {name: 'Company A', description: 'See if can change description'});
      }).then((group) => {
        assert(group.name === 'Company A', 'Group name returned incorrectly');
        assert(group.description === 'See if can change description', 'Description returned incorrectly');
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'group', object_id: marketId});
      }).then(() => {
        return adminClient.markets.createGroup({name: 'Team A', description: 'Group for team A.'})
      }).then((group) => {
        globalGroupId = group.id;
        assert(group.description === 'Group for team A.', 'Description returned incorrectly');
        assert(group.name === 'Team A', 'Group name returned incorrectly');
        return adminConfiguration.webSocketRunner.waitForReceivedMessages([
            {event_type: 'group', object_id: marketId}, {event_type: 'group_capability', object_id: marketId}]);
      }).then(() => {
        return adminClient.markets.listGroups();
      }).then((groups) => {
        groups.forEach((group) => {
          if (group.id !== marketId) {
            assert(group.users.length === 1, 'Team A wrong size');
            assert(group.users.includes(adminUserId), 'Team A wrong members');
          }
        });
        return adminClient.investibles.create({name: 'salmon spawning', description: 'plan to catch',
          groupId: globalGroupId, openForInvestment: true});
      }).then((investible) => {
        marketInvestibleId = investible.investible.id;
        return adminConfiguration.webSocketRunner.waitForReceivedMessage({event_type: 'market_investible',
          object_id: marketId});
      }).then(() => {
        return adminClient.markets.getMarketInvestibles([marketInvestibleId]);
      }).then((investibles) => {
        const fullInvestible = investibles[0];
        const { market_infos } = fullInvestible;
        const marketInfo = market_infos[0];
        const { addressed } = marketInfo;
        assert(addressed.length === 0, 'Addressed only includes those not included elsewhere');
        return loginUserToMarketInvite(userConfiguration, marketCapability);
      }).then((client) => {
        userClient = client;
        return client.users.get();
      }).then((me) => {
        userId = me.id;
        externalId = me.external_id;
        return userClient.investibles.follow(marketInvestibleId, [{user_id: userId, is_following: true}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'notification'},
          {event_type: 'addressed', object_id: marketId}]);
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const unassigned = messages.find(obj => {
          return obj.type_object_id === 'UNASSIGNED_' + marketInvestibleId;
        });
        assert(unassigned, 'Is unnassigned now that addressed on further work');
        return userClient.markets.getMarketInvestibles([marketInvestibleId]);
      }).then(() => {
        return userClient.markets.getMarketInvestibles([marketInvestibleId]);
      }).then((investibles) => {
        const fullInvestible = investibles[0];
        const { market_infos } = fullInvestible;
        const marketInfo = market_infos[0];
        const { addressed } = marketInfo;
        const notAbstaining = addressed.filter((address) => !address.abstain);
        assert(notAbstaining.length === 1, 'Addressed now only includes added user');
        assert(notAbstaining.find((address) => address.user_id === userId), 'Addressed now includes added user');
        return userClient.investibles.follow(marketInvestibleId, [{user_id: userId, is_following: false}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'notification'},
          {event_type: 'addressed', object_id: marketId}]);
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const unassigned = messages.find(obj => {
          return obj.type_object_id === 'UNASSIGNED_' + marketInvestibleId;
        });
        assert(!unassigned, 'No unnassigned now that not addressed on further work');
        return userClient.markets.getMarketInvestibles([marketInvestibleId]);
      }).then((investibles) => {
        const fullInvestible = investibles[0];
        const { market_infos } = fullInvestible;
        const marketInfo = market_infos[0];
        const { addressed } = marketInfo;
        const notAbstaining = addressed.filter((address) => !address.abstain);
        assert(notAbstaining.length === 0, 'Addressed no longer includes added user');
        return userClient.markets.followGroup(globalGroupId, [{user_id: userId, is_following: true}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessages([{event_type: 'notification'},
          {event_type: 'group_capability', object_id: marketId}]);
      }).then(() => {
        return getMessages(userConfiguration);
      }).then((messages) => {
        const unassigned = messages.find(obj => {
          return obj.type_object_id === 'UNASSIGNED_' + marketInvestibleId;
        });
        assert(unassigned, 'Is unnassigned now that addressed on further work');
        return adminClient.markets.listGroups();
      }).then((groups) => {
        groups.forEach((group) => {
          if (group.id !== marketId) {
            assert(group.users.length === 2, 'Team A wrong size');
            assert(group.users.includes(adminUserId), 'Team A wrong members');
            assert(group.users.includes(userId), 'Team A now includes added');
          }
        });
        return userClient.markets.followGroup(globalGroupId, [{user_id: userId, is_following: false}]);
      }).then(() => {
        return userConfiguration.webSocketRunner.waitForReceivedMessage(
            {event_type: 'group_capability', object_id: marketId});
      }).then(() => {
        return adminClient.markets.listGroups();
      }).then((groups) => {
        groups.forEach((group) => {
          if (group.id !== marketId) {
            assert(group.users.length === 1, 'Team A wrong size');
            assert(group.users.includes(adminUserId), 'Team A wrong members');
          }
        });
      }).catch(function (error) {
        console.log(error);
        throw error;
      });
    }).timeout(1200000);
  });
};

