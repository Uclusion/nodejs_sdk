import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { WebSocketRunner } from '../src/WebSocketRunner.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

const MESSAGE_TIMEOUT_MS = 120000;
const DUPLICATE_QUIET_WINDOW_MS = 15000;
const WEBSOCKET_TIMEOUT_CODE = 'WEBSOCKET_MESSAGE_TIMEOUT';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function (adminConfiguration) {
  describe('#test AI poke websocket integration', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let adminId;
    let marketId;
    let marketToken;
    let uclusionToken;
    let aiWebSocketRunner;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      accountToken = accountLogin.accountToken;
      const result = await accountClient.markets.createMarket({
        name: 'AI poke websocket integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      marketToken = marketLogin.marketToken;
      adminId = (await adminClient.users.get()).id;
      // This is the same market-scoped token used by the CLI proxy.
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);

      aiWebSocketRunner = new WebSocketRunner({
        wsUrl: adminConfiguration.websocketURL,
        reconnectInterval: 3000
      });
      aiWebSocketRunner.connect();
      aiWebSocketRunner.subscribe(uclusionToken, true);
      await aiWebSocketRunner.waitForOpen();
      await waitForSubscription(aiWebSocketRunner);
    });

    after(() => {
      if (aiWebSocketRunner) {
        aiWebSocketRunner.terminate();
      }
    });

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
          await sleep(3000);
        }
      }
      return mcpCall(adminConfiguration, uclusionToken, toolName, args);
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
      assert(ticketCode, `Ticket code missing for ${investible.investible.id}`);
      return ticketCode;
    }

    async function listPlanningComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || []).find((entry) => entry.market_id === marketId);
      const commentVersions = new Map();
      (marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const currentVersion = commentVersions.get(version.object_id_one) || 0;
          commentVersions.set(version.object_id_one, Math.max(currentVersion, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return adminClient.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    function assertPokeEnvelope(message) {
      assert.match(message.message_id || '', UUID_PATTERN, 'Poke should include a UUID message_id');
      assert(!Object.hasOwn(message, 'external_ids'),
        'Public websocket delivery should not expose internal routing ids');
    }

    it('should route a direct Poke AI action to an AI market-token subscription', async () => {
      const marker = `nodejs-sdk-direct-poke-${randomUUID()}`;
      const receivedPromise = aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: marker
      }, MESSAGE_TIMEOUT_MS);
      aiWebSocketRunner.pokeAI(marketToken, marker);
      const received = await receivedPromise;
      assertPokeEnvelope(received);
    }).timeout(180000);

    it('should emit exactly one correlated Responded poke when the last Unresponded item is cleared', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Responded transition ${marker}`,
        description: 'Fresh job containing exactly one AI-authored question.'
      });
      const jobTicketCode = await getTicketCode(job);
      const questionMarker = `AI question awaiting one human response ${marker}?`;
      const mcpResult = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: questionMarker
      });
      assert(mcpResult.includes('Added question with id'),
        `MCP ask_question response wrong: ${mcpResult}`);

      const comments = await pollFor(listPlanningComments,
        (fetched) => fetched.some((comment) => comment.body?.includes(questionMarker)));
      const question = comments.find((comment) => comment.body?.includes(questionMarker));
      assert(question, 'AI-authored question should be discoverable before replying');
      assert.notStrictEqual(question.created_by, adminId,
        'MCP question should be authored by the market AI user');
      const openAssistance = comments.filter((comment) =>
        comment.investible_id === job.investible.id &&
        ['QUESTION', 'SUGGEST', 'ISSUE'].includes(comment.comment_type) &&
        !comment.reply_id &&
        !comment.resolved &&
        !comment.deleted &&
        comment.is_sent !== false);
      assert.deepStrictEqual(openAssistance.map((comment) => comment.id), [question.id],
        'Fresh job should contain exactly one Unresponded assistance item before the reply');

      const respondedSignature = {
        event_type: 'poke_ai',
        message: `Responded ${jobTicketCode}`
      };
      const respondedPromise = aiWebSocketRunner.waitForReceivedMessage(
        respondedSignature, MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        `Human reply clearing the final Unresponded item ${marker}.`,
        question.id
      );
      const responded = await respondedPromise;
      assertPokeEnvelope(responded);

      await assert.rejects(
        aiWebSocketRunner.waitForReceivedMessage(
          respondedSignature, DUPLICATE_QUIET_WINDOW_MS),
        (error) => error.code === WEBSOCKET_TIMEOUT_CODE,
        `Correlated Responded should not be delivered again within ${DUPLICATE_QUIET_WINDOW_MS}ms`
      );
    }).timeout(240000);
  });
}
