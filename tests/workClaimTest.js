import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { WebSocketRunner } from '../src/WebSocketRunner.js';
import { mcpLogin, sleep } from './commonTestFunctions.js';

const CLAIM_TIMEOUT_MS = 30000;
const SHORT_EXPIRY_SECONDS = 10;
const WEBSOCKET_TIMEOUT_CODE = 'WEBSOCKET_MESSAGE_TIMEOUT';

export default function (adminConfiguration) {
  describe('#test work claim lock websocket integration', () => {
    let accountClient;
    let adminClient;
    let marketId;
    let uclusionToken;
    let jobTicketCode;
    let holderRunner;
    let rivalRunner;
    const extraRunners = [];

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      const result = await accountClient.markets.createMarket({
        name: 'Work claim lock integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      // This is the same market-scoped token used by the CLI proxy.
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);

      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: 'Job whose short code the claim lock protects',
        description: 'Two idle agents race to claim this job.'
      });
      jobTicketCode = await getTicketCode(job);

      holderRunner = await startAiRunner();
      rivalRunner = await startAiRunner();
    });

    after(() => {
      [holderRunner, rivalRunner, ...extraRunners]
        .filter((runner) => runner)
        .forEach((runner) => runner.terminate());
    });

    async function startAiRunner(ownedShortCodeIds = undefined) {
      const runner = new WebSocketRunner({
        wsUrl: adminConfiguration.websocketURL,
        reconnectInterval: 3000
      });
      runner.connect();
      runner.subscribe(uclusionToken, true, ownedShortCodeIds);
      await runner.waitForOpen();
      await waitForSubscription(runner);
      return runner;
    }

    async function waitForSubscription(webSocketRunner) {
      let lastTimeout;
      // subscribe has no acknowledgement. A pong proves the subscription row can be found for
      // this connection, so retry ping while its eventually-consistent index catches up.
      for (let i = 0; i < 12; i += 1) {
        const pongPromise = webSocketRunner.waitForReceivedMessage({ event_type: 'pong' }, 5000);
        webSocketRunner.send('ping');
        try {
          await pongPromise;
          return;
        } catch (error) {
          if (error.code !== WEBSOCKET_TIMEOUT_CODE) {
            throw error;
          }
          lastTimeout = error;
        }
      }
      throw lastTimeout;
    }

    async function claim(runner, shortCodeId, expirySeconds = undefined) {
      const messageId = randomUUID();
      const resultPromise = runner.waitForReceivedMessage({
        event_type: 'claim_result',
        message_id: messageId
      }, CLAIM_TIMEOUT_MS);
      runner.claimWork(uclusionToken, 'claim', shortCodeId, messageId, expirySeconds);
      return resultPromise;
    }

    async function release(runner, shortCodeId) {
      const messageId = randomUUID();
      const resultPromise = runner.waitForReceivedMessage({
        event_type: 'claim_result',
        message_id: messageId
      }, CLAIM_TIMEOUT_MS);
      runner.claimWork(uclusionToken, 'release', shortCodeId, messageId);
      return resultPromise;
    }

    // A lapsed or freed lock becomes claimable asynchronously, so retry the
    // claim itself; each denial is a complete round trip, not a busy wait.
    async function claimUntilGranted(runner, shortCodeId, attempts) {
      let result;
      for (let i = 0; i < attempts; i += 1) {
        result = await claim(runner, shortCodeId);
        if (result.claimed === true) {
          return result;
        }
        await sleep(3000);
      }
      return result;
    }

    // Rebind depends on the old holder's disconnect having processed, so
    // re-send the subscribe with owned codes until the server reports on them.
    async function subscribeUntilRebound(runner, shortCodeIds, expectRecovered) {
      let lastResult;
      for (let i = 0; i < 12; i += 1) {
        const rebindPromise = runner.waitForReceivedMessage(
          { event_type: 'rebind_result' }, 5000);
        runner.send({
          action: 'subscribe',
          identity: uclusionToken,
          is_ai: true,
          owned_short_code_ids: shortCodeIds
        });
        try {
          lastResult = await rebindPromise;
        } catch (error) {
          if (error.code !== WEBSOCKET_TIMEOUT_CODE) {
            throw error;
          }
          continue;
        }
        const recovered = lastResult.short_code_ids || [];
        const matches = shortCodeIds.every((code) =>
          recovered.includes(code) === expectRecovered);
        if (matches) {
          return lastResult;
        }
        await sleep(3000);
      }
      return lastResult;
    }

    async function getTicketCode(investible) {
      const marketInfo = investible.market_infos[0];
      if (marketInfo.ticket_code) {
        return marketInfo.ticket_code;
      }
      let ticketCode;
      for (let i = 0; i < 20 && !ticketCode; i += 1) {
        await sleep(3000);
        const fetched = await adminClient.markets.getMarketInvestibles([{
          investible: { id: investible.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        ticketCode = fetched?.[0]?.market_infos?.[0]?.ticket_code;
      }
      assert(ticketCode, `Ticket code missing for ${investible.investible.id}`);
      return ticketCode;
    }

    it('should grant the lock to the first claimant and deny the second until release', async () => {
      const granted = await claim(holderRunner, jobTicketCode);
      assert.strictEqual(granted.claimed, true, 'First claimant should get the lock');
      assert.strictEqual(granted.short_code_id, jobTicketCode,
        'Claim result should name the claimed short code');

      const denied = await claim(rivalRunner, jobTicketCode);
      assert.strictEqual(denied.claimed, false,
        'Second claimant should be denied while the lock is held');

      // A re-claim by the current holder stays granted, so a retried claim
      // after a dropped result cannot lock the holder out of its own work.
      const reclaimed = await claim(holderRunner, jobTicketCode);
      assert.strictEqual(reclaimed.claimed, true,
        'The holder re-claiming its own short code should stay granted');

      // Releasing someone else's lock must not free it.
      await release(rivalRunner, jobTicketCode);
      const deniedAfterForeignRelease = await claim(rivalRunner, jobTicketCode);
      assert.strictEqual(deniedAfterForeignRelease.claimed, false,
        'A non-holder release should leave the lock in place');

      await release(holderRunner, jobTicketCode);
      const grantedAfterRelease = await claimUntilGranted(rivalRunner, jobTicketCode, 5);
      assert.strictEqual(grantedAfterRelease.claimed, true,
        'The lock should be claimable after the holder releases it');
      await release(rivalRunner, jobTicketCode);
    }).timeout(240000);

    it('should grant the first free code from an ordered preference list', async () => {
      const codeA = `${jobTicketCode}-lista-${randomUUID().slice(0, 8)}`;
      const codeB = `${jobTicketCode}-listb-${randomUUID().slice(0, 8)}`;
      const holderGrant = await claim(holderRunner, codeA);
      assert.strictEqual(holderGrant.claimed, true, 'Holder should take the first code');

      // The rival lists both codes in preference order and must land on the
      // free one in a single round trip instead of eating a denial first.
      const rivalGrant = await claim(rivalRunner, [codeA, codeB]);
      assert.strictEqual(rivalGrant.claimed, true,
        'A preference list with a free code should be granted');
      assert.strictEqual(rivalGrant.short_code_id, codeB,
        'The grant should name the first free code from the list');

      // The holder listing both gets its own held code back, not a second one.
      const holderList = await claim(holderRunner, [codeA, codeB]);
      assert.strictEqual(holderList.claimed, true,
        'A holder listing its own held code should stay granted');
      assert.strictEqual(holderList.short_code_id, codeA,
        'The holder should be granted the code it already holds');

      const thirdRunner = await startAiRunner();
      extraRunners.push(thirdRunner);
      const denied = await claim(thirdRunner, [codeA, codeB]);
      assert.strictEqual(denied.claimed, false,
        'A list whose codes are all held should be denied as a whole');

      await release(holderRunner, codeA);
      await release(rivalRunner, codeB);
    }).timeout(240000);

    it('should let a claim lapse to a new claimant when its holder goes silent', async () => {
      const crashRunner = await startAiRunner();
      extraRunners.push(crashRunner);
      const shortCode = `${jobTicketCode}-lapse-${randomUUID().slice(0, 8)}`;
      const granted = await claim(crashRunner, shortCode, SHORT_EXPIRY_SECONDS);
      assert.strictEqual(granted.claimed, true, 'Crashing holder should first get the lock');
      const denied = await claim(rivalRunner, shortCode);
      assert.strictEqual(denied.claimed, false,
        'The lock should be held before the holder goes silent');
      // Simulated crash: no release, no further pings to refresh the expiry.
      crashRunner.terminate();
      const grantedAfterLapse = await claimUntilGranted(rivalRunner, shortCode, 15);
      assert.strictEqual(grantedAfterLapse.claimed, true,
        'A silent holder\'s claim should lapse to the next claimant after expiry');
      await release(rivalRunner, shortCode);
    }).timeout(240000);

    it('should re-bind a dead holder\'s claim on reconnect and refuse a live holder\'s', async () => {
      const firstConnection = await startAiRunner();
      extraRunners.push(firstConnection);
      const shortCode = `${jobTicketCode}-rebind-${randomUUID().slice(0, 8)}`;
      const granted = await claim(firstConnection, shortCode);
      assert.strictEqual(granted.claimed, true, 'Original connection should get the lock');
      // Simulated network break: the proxy reconnects with a new connection and
      // re-asserts the short codes it held.
      firstConnection.terminate();
      const reconnected = await startAiRunner();
      extraRunners.push(reconnected);
      const rebind = await subscribeUntilRebound(reconnected, [shortCode], true);
      assert(rebind?.short_code_ids?.includes(shortCode),
        'The reconnected holder should recover its claim while the old connection is gone');

      const denied = await claim(rivalRunner, shortCode);
      assert.strictEqual(denied.claimed, false,
        'The re-bound claim should still exclude other agents');

      // A different live connection listing the same code must not steal it.
      const thief = await startAiRunner();
      extraRunners.push(thief);
      const theftAttempt = await subscribeUntilRebound(thief, [shortCode], false);
      assert(theftAttempt && !(theftAttempt.short_code_ids || []).includes(shortCode),
        'A code held by a live connection must not re-bind to another subscriber');
      const stillDenied = await claim(rivalRunner, shortCode);
      assert.strictEqual(stillDenied.claimed, false,
        'The failed theft should leave the original claim in place');
      await release(reconnected, shortCode);
    }).timeout(300000);
  });
}
