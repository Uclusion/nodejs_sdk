import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration) {
  describe('#test find_work orders work oldest first (J-all-444)', () => {
    let accountClient;
    let adminClient;
    let marketId;
    let uclusionToken;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      const result = await accountClient.markets.createMarket({
        name: 'Find work ordering integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
    });

    // Backend effects propagate async so poll until the expected state or time runs out and the
    // caller's assert reports what is still wrong.
    async function pollFor(fetcher, isDone) {
      let result = await fetcher();
      for (let i = 0; i < 20 && !isDone(result); i += 1) {
        await sleep(3000);
        result = await fetcher();
      }
      return result;
    }

    // The AI user is created async on market creation, so retry the MCP call until it works.
    async function pollMcp(toolName, args) {
      for (let i = 0; i < 10; i += 1) {
        try {
          return await mcpCall(adminConfiguration, uclusionToken, toolName, args);
        } catch (error) {
          if (i === 9) {
            throw error;
          }
          await sleep(3000);
        }
      }
      return undefined;
    }

    async function getTicketCode(investible) {
      const marketInfo = investible.market_infos[0];
      if (marketInfo.ticket_code) {
        return marketInfo.ticket_code;
      }
      const fetcher = async () => {
        const fetched = await adminClient.markets.getMarketInvestibles([{
          investible: { id: investible.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        return fetched?.[0]?.market_infos?.[0]?.ticket_code;
      };
      const ticketCode = await pollFor(fetcher, (code) => code);
      assert(ticketCode, 'Ticket code never appeared for the created job');
      return ticketCode;
    }

    async function createJobIn(groupId, label) {
      const job = await adminClient.investibles.create({
        groupId,
        name: `${label} ${randomUUID()}`,
        description: 'Job used to assert find_work ordering.'
      });
      return getTicketCode(job);
    }

    // find_work returns JSON, and the surrounding suite treats MCP results as text.
    async function workCodes(expectedCodes) {
      const listed = await pollFor(
        () => pollMcp('find_work', {}),
        (raw) => expectedCodes.every((code) => (raw || '').includes(code))
      );
      const codes = [...listed.matchAll(/"short_code_id":\s*"([^"]+)"/g)].map((match) => match[1]);
      for (const code of expectedCodes) {
        assert(codes.includes(code), `find_work never listed ${code}. Got: ${codes.join(', ')}`);
      }
      // Other work in this fresh market must not make the assertions positional.
      return codes.filter((code) => expectedCodes.includes(code));
    }

    it('orders by creation rather than by ticket code, and appends new work at the end', async function () {
      this.timeout(900000);
      // The group name feeds the ticket sub code, so creating in Zulu first and Alpha second
      // makes creation order the exact opposite of ticket code order. Without created_at
      // reaching find_work every job ties and falls back to the ticket code, which would put
      // the Alpha job first. This is what makes the assertion below able to fail.
      const zuluGroup = await adminClient.markets.createGroup({ name: 'Zulu' });
      const oldestCode = await createJobIn(zuluGroup.group.id, 'Created first');

      const alphaGroup = await adminClient.markets.createGroup({ name: 'Alpha' });
      const middleCode = await createJobIn(alphaGroup.group.id, 'Created second');

      assert(middleCode < oldestCode,
        `Test premise broken: ${middleCode} should sort before ${oldestCode} by ticket code, `
        + 'so that ticket code order and creation order disagree');

      let ordered = await workCodes([oldestCode, middleCode]);
      assert.deepStrictEqual(ordered, [oldestCode, middleCode],
        'find_work must order by creation time, not by ticket code');

      // Creating work must not renumber what is already listed. That is the property the
      // ordering exists for, and it is the one a sorted-output assertion cannot check.
      const newestCode = await createJobIn(alphaGroup.group.id, 'Created third');
      ordered = await workCodes([oldestCode, middleCode, newestCode]);
      assert.deepStrictEqual(ordered, [oldestCode, middleCode, newestCode],
        'New work must append to the end, leaving existing positions unchanged');
    });
  });
}
