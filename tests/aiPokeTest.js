import assert from 'assert';
import { createHash, randomUUID } from 'crypto';
import AWS from 'aws-sdk';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarket,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { WebSocketRunner } from '../src/WebSocketRunner.js';
import { mcpCall, mcpLogin, mcpText, sleep } from './commonTestFunctions.js';

const MESSAGE_TIMEOUT_MS = 120000;
const DUPLICATE_QUIET_WINDOW_MS = 15000;
const BASELINE_QUIET_WINDOW_MS = 2000;
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
    let planningStages;
    let uclusionToken;
    let aiWebSocketRunner;
    const fixtureAgentId = randomUUID();

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
      planningStages = result.stages;
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

    // Membership in an inline option market is granted async.
    async function pollLogin(inlineMarketId) {
      for (let i = 0; i < 19; i += 1) {
        try {
          return await loginUserToMarket(adminConfiguration, inlineMarketId);
        } catch (error) {
          await sleep(3000);
        }
      }
      return loginUserToMarket(adminConfiguration, inlineMarketId);
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

    async function listMarketComments(client, targetMarketId) {
      const versions = await accountClient.summaries.versions(accountToken, [targetMarketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === targetMarketId);
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
      return client.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    async function listPlanningComments() {
      return listMarketComments(adminClient, marketId);
    }

    async function findCommentByMarker(client, targetMarketId, marker) {
      const comments = await pollFor(
        () => listMarketComments(client, targetMarketId),
        (fetched) => fetched.some((comment) => comment.body?.includes(marker))
      );
      return comments.find((comment) => comment.body?.includes(marker));
    }

    async function listMarketInvestibleIds(targetMarketId) {
      const versions = await accountClient.summaries.versions(accountToken, [targetMarketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === targetMarketId);
      return [...new Set((marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'investible')
        .flatMap((signature) => (signature.object_versions || [])
          .map((version) => version.object_id_one)))];
    }

    async function createCollaboratedJob(marker, { subscribe = true } = {}) {
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `AI collaborator event ${marker}`,
        description: 'Job used to verify response-worthy changes wake an existing AI collaborator.',
        assignments: [adminId]
      });
      const jobTicketCode = await getTicketCode(job);
      if (subscribe) {
        await subscription(jobTicketCode, fixtureAgentId);
      }
      const collaboratorMarker = `AI collaborator note ${marker}`;
      await pollMcp('add_info', {
        short_code_id: jobTicketCode,
        info: collaboratorMarker,
        tz: 'America/Los_Angeles'
      });
      const collaboratorComment = await findCommentByMarker(
        adminClient, marketId, collaboratorMarker);
      assert(collaboratorComment, 'AI collaborator comment should be discoverable');
      assert.notStrictEqual(collaboratorComment.created_by, adminId,
        'MCP add_info comment should be authored by the market AI user');
      return {
        job,
        jobTicketCode,
        aiUserId: collaboratorComment.created_by
      };
    }

    function assertPokeEnvelope(message) {
      assert.match(message.message_id || '', UUID_PATTERN, 'Poke should include a UUID message_id');
      assert(!Object.hasOwn(message, 'external_ids'),
        'Public websocket delivery should not expose internal routing ids');
    }

    async function assertNoPoke(signature, timeoutMilliseconds, message) {
      await assert.rejects(
        aiWebSocketRunner.waitForReceivedMessage(signature, timeoutMilliseconds),
        (error) => error.code === WEBSOCKET_TIMEOUT_CODE,
        message
      );
    }

    function structuredMcpResult(response) {
      const result = JSON.parse(response).result;
      assert(result && !result.isError, `MCP write was refused: ${mcpText(response)}`);
      assert(result.structuredContent, `MCP write returned no state: ${response}`);
      return result.structuredContent;
    }

    async function humanResolveQuestion(question, jobTicketCode) {
      const responded = aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai', message: `Responded ${question.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      const pending = await adminClient.investibles.updateComment(question.id, undefined, true);
      assert.strictEqual(pending.resolved, true);
      assert.strictEqual(pending.delegated, true);
      assert.strictEqual(pending.included_in_capsule, false);
      assert(Number.isInteger(pending.version) && pending.version > question.version);
      assertPokeEnvelope(await responded);
      return pending;
    }

    async function assertPendingQuestionMarkdown(jobTicketCode, question) {
      for (const sections of [undefined, ['assistance']]) {
        const response = await pollFor(
          () => mcpCall(adminConfiguration, uclusionToken, 'get_job', {
            short_code_id: jobTicketCode, ...(sections ? { sections } : {})
          }),
          (frame) => mcpText(frame).includes(`Question version: ${question.version}.`)
            && mcpText(frame).includes(question.ticket_code)
        );
        const markdown = mcpText(response);
        assert.match(markdown, /#### Assistance/);
        assert(markdown.includes(question.body.replace(/<[^>]*>/g, '')),
          'Default assistance should retain the pending question evidence');
        assert.match(markdown, new RegExp(
          `#### (?:Resolved )?Question ${question.ticket_code}<a name="[^"]+"></a>[^\\n]*\\n`
          + 'pending AI handling: a human resolved this and left the choice to you; '
          + `make it, then resolve with expected_question_version ${question.version}\\.\\n`
          + `Question version: ${question.version}\\.`
        ));
      }
    }

    it('should route a direct Poke AI action to an AI market-token subscription', async () => {
      const marker = `Start nodejs-sdk-direct-poke-${randomUUID()}`;
      const receivedPromise = aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: marker
      }, MESSAGE_TIMEOUT_MS);
      aiWebSocketRunner.pokeAI(marketToken, marker);
      const received = await receivedPromise;
      assertPokeEnvelope(received);
    }).timeout(180000);

    async function subscription(shortCode, agentId, extra = {}) {
      return structuredMcpResult(await mcpCall(adminConfiguration, uclusionToken,
        'set_agent_subscription', { short_code_id: shortCode, ...extra },
        { uclusionAgentId: agentId }));
    }

    async function assertPermanentSubscription(args, agentId) {
      await assert.rejects(() => mcpCall(adminConfiguration, uclusionToken, 'set_agent_subscription', args,
        { uclusionAgentId: agentId }).then(structuredMcpResult), /subscriptions are permanent/);
    }

    // A Claude Code or Cursor session's ID is name-based (version 5), derived from its delivery consumer.
    function consumerAgentId(consumer) {
      const bytes = createHash('sha1').update(`uclusion-integration:${consumer}`).digest().subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x50;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function savedPokeDecision(messageId) {
      // Promotion environments use separate AWS accounts with the dev stack.
      assert(['https://dev.api.uclusion.com/v1', 'https://stage.api.uclusion.com/v1',
        'https://production.api.uclusion.com/v1'].includes(adminConfiguration.baseURL));
      const dynamodb = new AWS.DynamoDB({ region: 'us-west-2' });
      const { Item } = await dynamodb.getItem({ TableName: 'uclusion-async-dev-ai-poke-routing',
        Key: { workspace_id: { S: marketId }, message_id: { S: messageId } }, ConsistentRead: true }).promise();
      return { decision: Item?.decision?.S, routing: Item?.routing_json?.S && JSON.parse(Item.routing_json.S) };
    }

    async function storedBugSubscribers(commentId) {
      assert(['https://dev.api.uclusion.com/v1', 'https://stage.api.uclusion.com/v1',
        'https://production.api.uclusion.com/v1'].includes(adminConfiguration.baseURL));
      const dynamodb = new AWS.DynamoDB({ region: 'us-west-2' });
      const { Item } = await dynamodb.getItem({ TableName: 'uclusion-markets-dev-comments',
        Key: { id: { S: commentId } }, ConsistentRead: true }).promise();
      assert.strictEqual(Item?.market_id?.S, marketId, 'Only this integration fixture may be read');
      return Item?.agent_subscribers?.SS || [];
    }

    async function manualRouting(shortCode, bootstrap = false) {
      const message = `${bootstrap ? 'Start' : 'Updated'} ${shortCode} probe-${randomUUID()}`;
      const received = aiWebSocketRunner.waitForReceivedMessage({ event_type: 'poke_ai', message },
        MESSAGE_TIMEOUT_MS);
      aiWebSocketRunner.pokeAI(marketToken, message, { short_code_id: shortCode });
      return (await received).routing;
    }

    async function nativeClaim(agentId, shortCode, work) {
      const messageId = randomUUID();
      const received = aiWebSocketRunner.waitForReceivedMessage({ event_type: 'claim_result', message_id: messageId },
        MESSAGE_TIMEOUT_MS);
      aiWebSocketRunner.send({ action: 'claim_work', identity: uclusionToken, message_id: messageId,
        agent_id: agentId, operation: work ? 'release' : 'claim', short_code_id: shortCode,
        ...(work ? { work } : {}) });
      return received;
    }

    async function replayableCommentEvent(commentId) {
      // Promotion environments use separate AWS accounts with the dev stack.
      assert(['https://dev.api.uclusion.com/v1', 'https://stage.api.uclusion.com/v1',
        'https://production.api.uclusion.com/v1'].includes(adminConfiguration.baseURL));
      const dynamodb = new AWS.DynamoDB({ region: 'us-west-2' });
      const { Item } = await dynamodb.getItem({ TableName: 'uclusion-markets-dev-comments',
        Key: { id: { S: commentId } }, ConsistentRead: true }).promise();
      assert.strictEqual(Item?.market_id?.S, marketId, 'Only this integration fixture may be replayed');
      return { Records: [{ eventName: 'INSERT', eventID: randomUUID(), eventSource: 'aws:dynamodb',
        dynamodb: { Keys: { id: { S: commentId } }, NewImage: Item } }] };
    }

    async function replayCommentEvent(event, message, messageId) {
      const received = aiWebSocketRunner.waitForReceivedMessage({ event_type: 'poke_ai', message,
        ...(messageId ? { message_id: messageId } : {}) }, MESSAGE_TIMEOUT_MS);
      await invokeCommentEvent(event);
      return received;
    }

    async function invokeCommentEvent(event) {
      const lambda = new AWS.Lambda({ region: 'us-west-2', maxRetries: 0,
        httpOptions: { timeout: 190000 } });
      const response = await lambda.invoke({ FunctionName: 'uclusion-async-dev-comments_triggered',
        InvocationType: 'RequestResponse', Payload: JSON.stringify(event) }).promise();
      assert.strictEqual(response.StatusCode, 200);
      assert(!response.FunctionError, Buffer.from(response.Payload || '').toString('utf8'));
    }

    it('suppresses new manual continuations without subscribers, including old-client requests', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({ groupId: marketId,
        name: `Unsubscribed manual work ${marker}`, description: 'Only Start may bootstrap delivery.' });
      const jobCode = await getTicketCode(job);
      for (const target of [undefined, { short_code_id: jobCode }]) {
        const message = `Updated ${jobCode} probe-${randomUUID()}`;
        aiWebSocketRunner.pokeAI(marketToken, message, target);
        await assertNoPoke({ event_type: 'poke_ai', message }, DUPLICATE_QUIET_WINDOW_MS,
          'Neither missing target nor connected legacy clients permit unsubscribed continuations');
      }
      assert.deepStrictEqual((await manualRouting(jobCode, true)).subscriber_agent_ids, []);
    }).timeout(240000);

    it('keeps an automatic response suppressed when the same stream event is replayed after subscription', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker, { subscribe: false });
      const question = structuredMcpResult(await pollMcp('ask_question', {
        job_id: jobTicketCode, question: `Unsubscribed response ${marker}?` }));
      const body = `No subscriber answer ${marker}`;
      const created = await adminClient.investibles.createComment(job.investible.id, marketId,
        body, question.comment_id);
      const reply = created.ticket_code ? created : await findCommentByMarker(adminClient, marketId, body);
      const message = `Responded ${reply.ticket_code} of ${jobTicketCode}`;
      await assertNoPoke({ event_type: 'poke_ai', message }, DUPLICATE_QUIET_WINDOW_MS,
        'AI collaboration alone must not emit a response without a subscriber');
      const replay = await replayableCommentEvent(reply.id);
      await invokeCommentEvent(replay);
      await subscription(jobTicketCode, fixtureAgentId);
      await invokeCommentEvent(replay);
      await assertNoPoke({ event_type: 'poke_ai', message }, DUPLICATE_QUIET_WINDOW_MS,
        'A saved suppression must not revive when subscribers change');
      const nextBody = `New subscribed answer ${marker}`;
      const nextCreated = await adminClient.investibles.createComment(job.investible.id, marketId,
        nextBody, question.comment_id);
      const next = nextCreated.ticket_code ? nextCreated
        : await findCommentByMarker(adminClient, marketId, nextBody);
      const emitted = await aiWebSocketRunner.waitForReceivedMessage({ event_type: 'poke_ai',
        message: `Responded ${next.ticket_code} of ${jobTicketCode}` }, MESSAGE_TIMEOUT_MS);
      assert.deepStrictEqual(emitted.routing.subscriber_agent_ids, [fixtureAgentId]);
    }).timeout(300000);

    it('keeps concurrent work subscriptions through nested replies and snapshots manual and automatic Pokes', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({ groupId: marketId,
        name: `Subscribed work ${marker}`, description: 'Subscription metadata has no semantic side effects.' });
      const jobCode = await getTicketCode(job);
      const agents = [randomUUID(), randomUUID()];
      const notificationsBefore = mcpText(await mcpCall(adminConfiguration, uclusionToken, 'get_notifications', {}));
      const stageBefore = mcpText(await mcpCall(adminConfiguration, uclusionToken, 'get_job', {
        short_code_id: jobCode, stage_only: true }));
      const writes = await Promise.all(agents.map((agent) => subscription(jobCode, agent)));
      assert(writes.every((write) => write.subscribed && write.work.kind === 'job'
        && write.work.short_code_id === jobCode));
      assert.strictEqual((await subscription(jobCode, agents[0])).agent_id, agents[0]);
      await assertNoPoke({ event_type: 'poke_ai', message: `Updated ${jobCode}` },
        BASELINE_QUIET_WINDOW_MS, 'Membership changes must not emit semantic Pokes');
      assert.strictEqual(mcpText(await mcpCall(adminConfiguration, uclusionToken, 'get_notifications', {})),
        notificationsBefore, 'Membership changes must not notify the human');
      assert.strictEqual(mcpText(await mcpCall(adminConfiguration, uclusionToken, 'get_job', {
        short_code_id: jobCode, stage_only: true })), stageBefore, 'Membership changes must not change stage');
      const snapshot = await manualRouting(jobCode);
      assert.strictEqual(snapshot.version, 1);
      assert.deepStrictEqual(snapshot.subscriber_agent_ids, [...agents].sort());

      const question = structuredMcpResult(await pollMcp('ask_question', { job_id: jobCode,
        question: `Subscribed question ${marker}?`,
        options: [{ name: 'One option', description: 'Exercise inline ancestry.' }],
        initial_vote: { new_option_index: 0, certainty: 3, reason: 'Exercise the selected path.' } }));
      const nested = await subscription(question.options[0].short_code_id, agents[0]);
      assert.deepStrictEqual(nested.work, writes[0].work, 'Inline option must resolve to the same canonical job');
      const reply = await adminClient.investibles.createComment(job.investible.id, marketId,
        `Answer ${marker}`, question.comment_id);
      const replied = reply.ticket_code ? reply : await findCommentByMarker(adminClient, marketId, `Answer ${marker}`);
      const response = await aiWebSocketRunner.waitForReceivedMessage({ event_type: 'poke_ai',
        message: `Responded ${replied.ticket_code} of ${jobCode}` }, MESSAGE_TIMEOUT_MS);
      assert.deepStrictEqual(response.routing, snapshot,
        'The actual human response path must carry the same work and subscriber snapshot');
      const replayEvent = await replayableCommentEvent(replied.id);
      const firstReplay = await replayCommentEvent(replayEvent, response.message);
      assert.deepStrictEqual(firstReplay.routing, snapshot);
      // Subscriptions are permanent: a release request is refused and changes nothing.
      await assertPermanentSubscription({ short_code_id: replied.ticket_code, action: 'unsubscribe' }, agents[0]);
      const later = randomUUID();
      // Already installed guidance still names the action.
      assert.strictEqual((await subscription(jobCode, later, { action: 'subscribe' })).subscribed, true);
      assert.deepStrictEqual((await manualRouting(jobCode)).subscriber_agent_ids, [...agents, later].sort());
      const retried = await replayCommentEvent(replayEvent, response.message, firstReplay.message_id);
      assert.deepStrictEqual(retried.routing, firstReplay.routing,
        'A successful stream send followed by replay must retain its saved recipients after a later subscription');
      await assert.rejects(() => mcpCall(adminConfiguration, uclusionToken, 'set_agent_subscription', {
        short_code_id: jobCode }).then(structuredMcpResult), /native caller identity/);
    }).timeout(300000);

    it('keeps a moved bug subscription, adds the new job subscription and stays within workspace scope', async () => {
      const marker = randomUUID();
      const agent = randomUUID();
      const created = await adminClient.investibles.createComment(undefined, marketId,
        `Subscribed standalone bug ${marker}`, null, 'TODO');
      const bug = created.ticket_code ? created
        : await findCommentByMarker(adminClient, marketId, `Subscribed standalone bug ${marker}`);
      const originalClaim = await nativeClaim(agent, bug.ticket_code);
      assert.strictEqual(originalClaim.claimed, true);
      const original = await subscription(bug.ticket_code, agent);
      assert.deepStrictEqual(original.work, originalClaim.work);
      assert.strictEqual(original.work.kind, 'bug');
      const emitted = await manualRouting(bug.ticket_code);
      await pollMcp('add_job', { name: `Moved subscribed bug ${marker}`,
        description: 'Move while retaining the emitted snapshot.', bug_short_code_ids: [bug.ticket_code] });
      const rival = randomUUID();
      const rivalClaim = await nativeClaim(rival, bug.ticket_code);
      assert.strictEqual(rivalClaim.claimed, true);
      assert.strictEqual(rivalClaim.work.kind, 'job');
      assert.strictEqual((await nativeClaim(agent, bug.ticket_code)).claimed, false,
        'The original bug lease must not bypass a denied new job claim');
      assert.deepStrictEqual((await manualRouting(bug.ticket_code, true)).subscriber_agent_ids, [],
        'An unfinished automatic handoff must not subscribe to denied work');
      await nativeClaim(rival, rivalClaim.work.short_code_id, rivalClaim.work);
      const currentClaim = await nativeClaim(agent, bug.ticket_code);
      assert.strictEqual(currentClaim.claimed, true);
      const current = await subscription(bug.ticket_code, agent);
      assert.deepStrictEqual(current.work, currentClaim.work);
      assert.strictEqual(current.work.kind, 'job');
      assert.notStrictEqual(current.work.id, original.work.id);
      await assertPermanentSubscription({ short_code_id: bug.ticket_code, work_id: original.work.id }, agent);
      assert.deepStrictEqual(await storedBugSubscribers(original.work.id), [agent],
        'The former bug keeps its subscription after the move');
      assert.strictEqual((await nativeClaim(agent, originalClaim.work.short_code_id, originalClaim.work)).released, true);
      assert.strictEqual((await nativeClaim(rival, current.work.short_code_id)).claimed, false,
        'Releasing the recorded bug lease must leave the new job lease intact');
      assert.deepStrictEqual((await manualRouting(bug.ticket_code)).subscriber_agent_ids, [agent]);
      assert.strictEqual(emitted.work.kind, 'bug');
      assert.deepStrictEqual(emitted.subscriber_agent_ids, [agent]);
      const foreignMarket = await accountClient.markets.createMarket({
        name: `Subscription scope ${marker}`, market_type: 'PLANNING' });
      await loginUserToMarketInvite(adminConfiguration, foreignMarket.market.invite_capability);
      const foreignClient = await loginUserToMarket(adminConfiguration, foreignMarket.market.id);
      const foreignToken = await mcpLogin(adminConfiguration, foreignClient, foreignMarket.market.id);
      await assert.rejects(() => mcpCall(adminConfiguration, foreignToken, 'set_agent_subscription', {
        short_code_id: current.work.short_code_id }, { uclusionAgentId: randomUUID() }).then(structuredMcpResult));
      assert.deepStrictEqual((await manualRouting(current.work.short_code_id)).subscriber_agent_ids, [agent],
        'Another workspace cannot subscribe to this work');
      await nativeClaim(agent, currentClaim.work.short_code_id, currentClaim.work);
    }).timeout(300000);

    it('records a human option vote as subscribed for a consumer-derived Claude Code or Cursor subscriber', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({ groupId: marketId,
        name: `Consumer subscriber ${marker}`,
        description: 'A session without native identity subscribes with its delivery consumer.' });
      const jobTicketCode = await getTicketCode(job);
      const agent = consumerAgentId(`session-claude-${marker}`);
      assert.match(agent, UUID_PATTERN);
      const subscribed = await subscription(jobTicketCode, agent);
      assert.strictEqual(subscribed.subscribed, true);
      assert.strictEqual(subscribed.agent_id, agent);
      const questionMarker = `Consumer subscriber vote ${marker}?`;
      const question = structuredMcpResult(await pollMcp('ask_question', { job_id: jobTicketCode,
        question: questionMarker,
        options: [{ name: `Vote target ${marker}`, description: 'The human votes for this option.' }],
        initial_vote: { new_option_index: 0, certainty: 3, reason: 'Exercise a human vote on an inline option.' } }));
      const parentQuestion = await findCommentByMarker(adminClient, marketId, questionMarker);
      assert(parentQuestion?.inline_market_id, 'AI-authored question should have an inline market');
      const optionCode = question.options[0].short_code_id.split('_').pop();
      const inlineAdminClient = await pollLogin(parentQuestion.inline_market_id);
      const optionIds = await pollFor(() => listMarketInvestibleIds(parentQuestion.inline_market_id),
        (ids) => ids.length > 0);
      assert.strictEqual(optionIds.length, 1, 'The question should have exactly one option to vote on');
      const responded = aiWebSocketRunner.waitForReceivedMessage({ event_type: 'poke_ai',
        message: `Responded ${optionCode} of ${question.short_code_id}` }, MESSAGE_TIMEOUT_MS);
      await inlineAdminClient.markets.updateInvestment(optionIds[0], 100, 0);
      const received = await responded;
      assertPokeEnvelope(received);
      assert.deepStrictEqual(received.routing.subscriber_agent_ids, [agent]);
      assert.deepStrictEqual(received.routing.work, subscribed.work);
      const saved = await savedPokeDecision(received.message_id);
      assert.strictEqual(saved.decision, 'subscribed', 'The saved emission decision must record the subscriber');
      assert.deepStrictEqual(saved.routing.subscriber_agent_ids, [agent]);
    }).timeout(300000);

    it('should emit one compound Responded poke when the last open assistance is answered', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Responded transition ${marker}`,
        description: 'Fresh job containing exactly one AI-authored question.'
      });
      const jobTicketCode = await getTicketCode(job);
      await subscription(jobTicketCode, fixtureAgentId);
      const questionMarker = `AI question awaiting one human response ${marker}?`;
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: questionMarker
      });

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

      const answerMarker = `Human reply clearing the final open assistance ${marker}.`;
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        answerMarker,
        question.id
      );
      const answer = await findCommentByMarker(adminClient, marketId, answerMarker);
      assert(answer?.ticket_code, 'The answering reply should have a ticket code');
      // Q-all-443: the answer that clears the last open assistance carries its
      // own compound identity like every other response; the former bare job
      // form was a computed backend rule that was never asked for.
      const respondedSignature = {
        event_type: 'poke_ai',
        message: `Responded ${answer.ticket_code} of ${jobTicketCode}`
      };
      const responded = await aiWebSocketRunner.waitForReceivedMessage(
        respondedSignature, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(responded);

      await assertNoPoke(
        { event_type: 'poke_ai', message: `Responded ${jobTicketCode}` },
        BASELINE_QUIET_WINDOW_MS,
        'The removed bare job-identity transition must not be delivered'
      );
      await assert.rejects(
        aiWebSocketRunner.waitForReceivedMessage(
          respondedSignature, DUPLICATE_QUIET_WINDOW_MS),
        (error) => error.code === WEBSOCKET_TIMEOUT_CODE,
        `Correlated Responded should not be delivered again within ${DUPLICATE_QUIET_WINDOW_MS}ms`
      );
    }).timeout(240000);

    it('should retain human-delegated questions until versioned capsule acknowledgement', async () => {
      const marker = randomUUID();
      const { jobTicketCode } = await createCollaboratedJob(marker);
      const questionMarker = `Choose the retained capsule outcome ${marker}?`;
      await pollMcp('ask_question', { job_id: jobTicketCode, question: questionMarker });
      const question = await findCommentByMarker(adminClient, marketId, questionMarker);
      assert(question?.ticket_code, 'The AI question should have a full code');
      assert.notStrictEqual(question.created_by, adminId);
      const capsule = `## Outcome\nRetain the existing result ${marker}.`;
      const published = structuredMcpResult(await mcpCall(
        adminConfiguration, uclusionToken, 'set_design_capsule', { job_id: jobTicketCode, capsule }
      ));

      const pending = await humanResolveQuestion(question, jobTicketCode);
      await assertPendingQuestionMarkdown(jobTicketCode, pending);
      const acknowledged = structuredMcpResult(await mcpCall(
        adminConfiguration, uclusionToken, 'set_design_capsule', {
          job_id: jobTicketCode, capsule,
          resolve_question_short_code_ids: [question.ticket_code],
          resolve_question_versions: { [question.ticket_code]: pending.version }
        }
      ));
      assert.strictEqual(acknowledged.status, 'unchanged');
      assert.strictEqual(acknowledged.capsule_short_code_id, published.capsule_short_code_id);
      assert.strictEqual(acknowledged.capsule_version, published.capsule_version);
      const [outcome] = acknowledged.question_resolutions;
      assert.strictEqual(outcome.short_code_id, question.ticket_code);
      assert.strictEqual(outcome.status, 'completed');
      assert.strictEqual(outcome.resolved, true);
      assert.strictEqual(outcome.delegated, false);
      assert.strictEqual(outcome.included_in_capsule, true);
      assert(outcome.question_version > pending.version);

      const reopenPoke = aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai', message: `Updated ${question.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      const reopened = await adminClient.investibles.updateComment(question.id, undefined, false);
      assert.strictEqual(reopened.resolved, false);
      assert.strictEqual(reopened.delegated, false);
      assert.strictEqual(reopened.included_in_capsule, false);
      assertPokeEnvelope(await reopenPoke);
      const requeued = await humanResolveQuestion(reopened, jobTicketCode);
      assert(requeued.version > outcome.question_version);
      const stale = await mcpCall(adminConfiguration, uclusionToken, 'resolve', {
        short_code_id: question.ticket_code, expected_question_version: pending.version,
        included_in_capsule: true
      });
      assert.strictEqual(JSON.parse(stale).result.isError, true);
      assert.match(mcpText(stale), /changed since the supplied evidence version/);
      await assertPendingQuestionMarkdown(jobTicketCode, requeued);
      const comments = await pollFor(listPlanningComments, (items) =>
        items.some((item) => item.id === question.id && item.version >= requeued.version));
      const retained = comments.find((item) => item.id === question.id);
      assert.strictEqual(retained.version, requeued.version);
      assert.strictEqual(retained.delegated, true);
      assert.strictEqual(retained.included_in_capsule, false);
    }).timeout(360000);

    it('should consume delegated handling without a capsule and preserve it on retries', async () => {
      const marker = randomUUID();
      const { jobTicketCode } = await createCollaboratedJob(marker);
      const questionMarker = `Choose without changing the capsule ${marker}?`;
      await pollMcp('ask_question', { job_id: jobTicketCode, question: questionMarker });
      const question = await findCommentByMarker(adminClient, marketId, questionMarker);
      assert(question?.ticket_code);
      const pending = await humanResolveQuestion(question, jobTicketCode);
      const settled = structuredMcpResult(await mcpCall(adminConfiguration, uclusionToken, 'resolve', {
        short_code_id: question.ticket_code, expected_question_version: pending.version
      }));
      assert.strictEqual(settled.resolved, true);
      assert.strictEqual(settled.delegated, false);
      assert.strictEqual(settled.included_in_capsule, false);
      assert(settled.question_version > pending.version);
      const retried = structuredMcpResult(await mcpCall(
        adminConfiguration, uclusionToken, 'resolve', { short_code_id: question.ticket_code }
      ));
      assert.deepStrictEqual(retried, settled);
      const humanRetry = await adminClient.investibles.updateComment(question.id, undefined, true);
      assert.strictEqual(humanRetry.version, settled.question_version);
      assert.strictEqual(humanRetry.resolved, true);
      assert.strictEqual(humanRetry.delegated, false);
      assert.strictEqual(humanRetry.included_in_capsule, false);
      const response = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', {
          short_code_id: jobTicketCode, sections: ['assistance']
        }),
        (frame) => JSON.parse(frame).result?.isError !== true
          && mcpText(frame).includes(`## Job ${jobTicketCode}`)
          && !mcpText(frame).includes(question.ticket_code)
      );
      assert(JSON.parse(response).result && JSON.parse(response).result.isError !== true,
        `Assistance read failed: ${mcpText(response)}`);
      assert(mcpText(response).includes(`## Job ${jobTicketCode}`), 'Assistance should return the expected job');
      assert(!mcpText(response).includes(questionMarker), 'Consumed handling should leave default assistance');
    }).timeout(240000);

    // S-all-228: with several questions open, every response hands back, not
    // just the job-unblocking one - the job-wide gate used to swallow the rest.
    // B-all-554: a response landing after its question already sat Responded
    // hands back too - the per-question flip gate used to swallow those.
    it('should emit a compound Responded poke for each of two open questions', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Multi question responses ${marker}`,
        description: 'Job with two open AI questions answered in one sitting.'
      });
      const jobTicketCode = await getTicketCode(job);
      await subscription(jobTicketCode, fixtureAgentId);
      const firstMarker = `First AI question of a pair ${marker}?`;
      const secondMarker = `Second AI question of a pair ${marker}?`;
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: firstMarker
      });
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: secondMarker
      });
      const firstQuestion = await findCommentByMarker(adminClient, marketId, firstMarker);
      const secondQuestion = await findCommentByMarker(adminClient, marketId, secondMarker);
      assert(firstQuestion?.ticket_code && secondQuestion?.ticket_code,
        'Both AI questions should be discoverable with ticket codes');

      const firstReplyMarker = `Answer to the first question ${marker}.`;
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        firstReplyMarker,
        firstQuestion.id
      );
      const firstReply = await findCommentByMarker(adminClient, marketId, firstReplyMarker);
      assert(firstReply?.ticket_code, 'First answer should have a ticket code');
      // The 2 -> 1 response the job-wide gate used to swallow must hand back.
      const firstResponded = await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: `Responded ${firstReply.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(firstResponded);
      await assertNoPoke(
        { event_type: 'poke_ai', message: `Responded ${jobTicketCode}` },
        BASELINE_QUIET_WINDOW_MS,
        'No bare job-identity Responded exists under the compound contract'
      );

      // Q-all-443: the answer clearing the last open question is compound like
      // every other response; the former bare job form was removed.
      const secondReplyMarker = `Answer to the second question ${marker}.`;
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        secondReplyMarker,
        secondQuestion.id
      );
      const secondReply = await findCommentByMarker(adminClient, marketId, secondReplyMarker);
      assert(secondReply?.ticket_code, 'Second answer should have a ticket code');
      const secondResponded = await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: `Responded ${secondReply.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(secondResponded);
      await assertNoPoke(
        { event_type: 'poke_ai', message: `Responded ${jobTicketCode}` },
        BASELINE_QUIET_WINDOW_MS,
        'The removed bare job-identity transition must not be delivered'
      );

      // B-all-554: the first question already sits Responded, so the old flip
      // gate would swallow this follow-up answer entirely.
      const lateReplyMarker = `Follow-up answer after the hand-back ${marker}.`;
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        lateReplyMarker,
        firstQuestion.id
      );
      const lateReply = await findCommentByMarker(adminClient, marketId, lateReplyMarker);
      assert(lateReply?.ticket_code, 'Follow-up answer should have a ticket code');
      const lateResponded = await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: `Responded ${lateReply.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(lateResponded);
    }).timeout(300000);

    // Q-all-340 A / S-all-182: reopen and the first reply after it both hand back.
    it('should emit Responded on reopen and again on the first reply after reopen', async () => {
      const marker = randomUUID();
      // Prior AI collaboration makes later human mutations on this market eligible.
      await createCollaboratedJob(marker);

      const bugMarker = `Standalone bug both-poke ${marker}`;
      const bug = await adminClient.investibles.createComment(
        undefined,
        marketId,
        bugMarker,
        null,
        'TODO'
      );
      const persistedBug = bug.ticket_code
        ? bug
        : await findCommentByMarker(adminClient, marketId, bugMarker);
      assert(persistedBug?.ticket_code, 'Standalone bug should have a ticket code');
      const bugTicketCode = persistedBug.ticket_code;
      await subscription(bugTicketCode, fixtureAgentId);
      // Standalone market-level TODOs do not emit Added — that path is for
      // investible-attached tasks when AI already collaborates. Collaboration
      // for the later Responded hand-backs comes from createCollaboratedJob
      // plus the AI completion note below.

      const completionMarker = `AI completion note for both-poke ${marker}`;
      await pollMcp('add_info', {
        short_code_id: bugTicketCode,
        info: completionMarker,
        tz: 'America/Los_Angeles'
      });
      const completion = await findCommentByMarker(
        adminClient, marketId, completionMarker);
      assert(completion, 'AI completion note should be discoverable');
      assert.notStrictEqual(completion.created_by, adminId,
        'MCP add_info comment should be authored by the market AI user');

      await pollMcp('resolve', {
        short_code_id: bugTicketCode
      });
      const resolvedBug = await pollFor(
        () => listPlanningComments().then((comments) =>
          comments.find((comment) => comment.id === persistedBug.id)),
        (comment) => comment?.resolved === true
      );
      assert.strictEqual(resolvedBug?.resolved, true,
        'Standalone bug should be resolved before the human reopen');

      const respondedSignature = {
        event_type: 'poke_ai',
        message: `Responded ${bugTicketCode}`
      };
      await assertNoPoke(
        respondedSignature,
        BASELINE_QUIET_WINDOW_MS,
        'AI completion and resolve should not queue Responded before the human reopen'
      );

      const reopenPromise = aiWebSocketRunner.waitForReceivedMessage(
        respondedSignature, MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.updateComment(persistedBug.id, undefined, false);
      const reopenPoke = await reopenPromise;
      assertPokeEnvelope(reopenPoke);

      // S-all-252: view-level replies carry their own compound identity, and
      // every consecutive human reply pokes - turn chronology left the backend.
      const firstDirectionMarker = `Also do X after reopen ${marker}`;
      await adminClient.investibles.createComment(
        undefined,
        marketId,
        firstDirectionMarker,
        persistedBug.id
      );
      const firstDirection = await findCommentByMarker(
        adminClient, marketId, firstDirectionMarker);
      assert(firstDirection?.ticket_code, 'Reply after reopen should have a ticket code');
      const replyPoke = await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: `Responded ${firstDirection.ticket_code} of ${bugTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(replyPoke);

      const secondDirectionMarker = `Even more direction after reopen ${marker}`;
      await adminClient.investibles.createComment(
        undefined,
        marketId,
        secondDirectionMarker,
        persistedBug.id
      );
      const secondDirection = await findCommentByMarker(
        adminClient, marketId, secondDirectionMarker);
      assert(secondDirection?.ticket_code, 'Second reply after reopen should have a ticket code');
      const secondReplyPoke = await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: `Responded ${secondDirection.ticket_code} of ${bugTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(secondReplyPoke);
    }).timeout(360000);

    it('should emit one compound Responded poke for a human question inside an AI option', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Nested option response ${marker}`,
        description: 'Job whose AI-authored question receives a human question inside its option.'
      });
      const jobTicketCode = await getTicketCode(job);
      await subscription(jobTicketCode, fixtureAgentId);
      const parentMarker = `AI parent question with an option ${marker}?`;
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: parentMarker,
        options: [{
          name: `Option ${marker}`,
          description: 'Option whose discussion receives the nested human question.'
        }],
        initial_vote: { new_option_index: 0, certainty: 3,
          reason: 'Use this option while its nested question is clarified.' }
      });

      const parentQuestion = await findCommentByMarker(adminClient, marketId, parentMarker);
      assert(parentQuestion, 'AI-authored parent question should be discoverable');
      assert(parentQuestion.inline_market_id, 'AI-authored question should have an inline market');
      assert(parentQuestion.ticket_code, 'AI-authored question should have a global ticket code');
      assert.notStrictEqual(parentQuestion.created_by, adminId,
        'MCP question should be authored by the market AI user');

      const inlineMarketId = parentQuestion.inline_market_id;
      const inlineAdminClient = await pollLogin(inlineMarketId);
      const optionIds = await pollFor(
        () => listMarketInvestibleIds(inlineMarketId),
        (ids) => ids.length > 0
      );
      assert.strictEqual(optionIds.length, 1,
        'The parent question should have exactly one option for the nested response');

      const nestedMarker = `Human question inside the AI option ${marker}?`;
      const nestedQuestion = await inlineAdminClient.investibles.createComment(
        optionIds[0],
        inlineMarketId,
        nestedMarker,
        null,
        'QUESTION'
      );
      const persistedNestedQuestion = nestedQuestion.ticket_code
        ? nestedQuestion
        : await findCommentByMarker(inlineAdminClient, inlineMarketId, nestedMarker);
      assert(persistedNestedQuestion?.ticket_code,
        'Nested human question should have a market-local ticket code');

      const respondedSignature = {
        event_type: 'poke_ai',
        message: `Responded ${persistedNestedQuestion.ticket_code} of ${parentQuestion.ticket_code}`
      };
      const responded = await aiWebSocketRunner.waitForReceivedMessage(
        respondedSignature, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(responded);

      await assert.rejects(
        aiWebSocketRunner.waitForReceivedMessage(
          respondedSignature, DUPLICATE_QUIET_WINDOW_MS),
        (error) => error.code === WEBSOCKET_TIMEOUT_CODE,
        `Compound Responded should not be delivered again within ${DUPLICATE_QUIET_WINDOW_MS}ms`
      );
    }).timeout(300000);

    it('should suppress Added but keep Updated for items inside a hidden job', async () => {
      // B-all-531: Added pokes observe is_visible on the enclosing job; Updated
      // still flows because a human can Start AI on an item in a hidden job and
      // then edit it (Q-all-362).
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      await adminClient.investibles.updateIsVisible(job.investible.id, false);
      try {
        const task = await adminClient.investibles.createComment(
          job.investible.id,
          marketId,
          `Human only task ${marker}`,
          null,
          'TODO'
        );
        assert(task.ticket_code, 'Task should carry a ticket code');
        await assertNoPoke(
          { event_type: 'poke_ai', message: `Added ${task.ticket_code} of ${jobTicketCode}` },
          BASELINE_QUIET_WINDOW_MS,
          'A task created inside a hidden job must not emit an Added poke'
        );
        const updatedPromise = aiWebSocketRunner.waitForReceivedMessage(
          { event_type: 'poke_ai', message: `Updated ${task.ticket_code} of ${jobTicketCode}` },
          MESSAGE_TIMEOUT_MS);
        // Body edits require the comment's version
        await adminClient.investibles.updateComment(task.id, `Human only task edited ${marker}`,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, task.version);
        await updatedPromise;
      } finally {
        // leave the job visible again so later tests see normal behavior
        await adminClient.investibles.updateIsVisible(job.investible.id, true);
      }
    }).timeout(300000);

    it('should emit exactly one Added when an option-bearing draft question is sent', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const questionMarker = `Human option-bearing draft question ${marker}?`;
      // Mirror the UI wizard: create the question and its DECISION market as one draft operation,
      // add an option in that inline market, then send the parent comment.
      const draftResponse = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        questionMarker,
        null,
        'QUESTION',
        undefined,
        undefined,
        undefined,
        'DECISION',
        undefined,
        false
      );
      const draftQuestion = draftResponse.parent;
      const inlineMarketId = draftResponse.market?.id;
      assert(draftQuestion, 'Draft question response should include its parent comment');
      assert.strictEqual(draftQuestion.is_sent, false, 'Question should remain a draft until finalized');
      assert(draftQuestion.ticket_code, 'Draft question should already have a ticket code');
      assert.match(draftQuestion.ticket_code, /^Q-/,
        'Draft question should use a question short code');
      assert(inlineMarketId, 'Draft question should create its inline decision market');

      const addedSignature = {
        event_type: 'poke_ai',
        // J-all-380: a comment on a job pokes with its enclosing job as parent
        message: `Added ${draftQuestion.ticket_code} of ${jobTicketCode}`
      };
      await assertNoPoke(
        addedSignature,
        BASELINE_QUIET_WINDOW_MS,
        'Creating the draft question should not publish an Added event'
      );

      const inlineAdminClient = await pollLogin(inlineMarketId);
      const investmentStage = draftResponse.stages?.find((stage) => stage.allows_investment);
      assert(investmentStage, 'Inline decision market should include an investment stage');
      await inlineAdminClient.investibles.create({
        groupId: inlineMarketId,
        name: `Human option ${marker}`,
        description: 'Option created while its parent question is still a draft.',
        stageId: investmentStage.id
      });
      await assertNoPoke(
        addedSignature,
        BASELINE_QUIET_WINDOW_MS,
        'Adding an option to an unsent question should not publish the parent'
      );

      const addedPromise = aiWebSocketRunner.waitForReceivedMessage(
        addedSignature, MESSAGE_TIMEOUT_MS);
      const sentQuestion = await adminClient.investibles.updateComment(
        draftQuestion.id,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        'DECISION'
      );
      assert.strictEqual(sentQuestion.id, draftQuestion.id,
        'Finalizing the draft should update the same question');
      assert.strictEqual(sentQuestion.is_sent, true, 'Finalized question should be sent');
      const added = await addedPromise;
      assertPokeEnvelope(added);

      await assertNoPoke(
        addedSignature,
        DUPLICATE_QUIET_WINDOW_MS,
        `Sent question Added should not be delivered again within ${DUPLICATE_QUIET_WINDOW_MS}ms`
      );
    }).timeout(300000);

    it('should emit Added for a human-created task when AI already collaborates', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const taskMarker = `Human task for existing AI collaborator ${marker}`;
      const task = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        taskMarker,
        null,
        'TODO'
      );
      const persistedTask = task.ticket_code
        ? task
        : await findCommentByMarker(adminClient, marketId, taskMarker);
      assert(persistedTask?.ticket_code, 'Human-created task should have a ticket code');

      const added = await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        // J-all-380: a comment on a job pokes with its enclosing job as parent
        message: `Added ${persistedTask.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);
      assertPokeEnvelope(added);
      assert.notStrictEqual(persistedTask.ticket_code, jobTicketCode,
        'Task mutation should target the task rather than its enclosing job');
    }).timeout(240000);

    it('should Poke for silent AI job/task context while preserving other AI echoes', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode, aiUserId } = await createCollaboratedJob(marker);
      const task = await adminClient.investibles.createComment(
        job.investible.id, marketId, `Silent context task ${marker}`, null, 'TODO');
      const taskState = await findCommentByMarker(adminClient, marketId, `Silent context task ${marker}`);
      assert(taskState?.ticket_code);
      await aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai', message: `Added ${taskState.ticket_code} of ${jobTicketCode}`
      }, MESSAGE_TIMEOUT_MS);

      async function addContext(targetCode, label, isSilent = true, fields = {}) {
        const body = `${label} ${marker}`;
        const response = await mcpCall(adminConfiguration, uclusionToken, 'add_info', {
          short_code_id: targetCode, info: body, is_silent: isSilent,
          tz: 'America/Los_Angeles', ...fields
        });
        const result = JSON.parse(response).result;
        assert(result && !result.isError, `Context write failed: ${response}`);
        const context = result.structuredContent;
        assert(context?.comment_id && context.short_code_id,
          `Context write returned no comment identity: ${response}`);
        const comments = await pollFor(listPlanningComments, (items) =>
          items.some((comment) => comment.id === context.comment_id
            && comment.ticket_code === context.short_code_id && comment.is_silent === isSilent));
        const stored = comments.find((comment) => comment.id === context.comment_id);
        assert.strictEqual(stored?.ticket_code, context.short_code_id,
          `Context ${context.short_code_id} did not reach human hydration: ${JSON.stringify(stored)}`);
        assert.strictEqual(stored.is_silent, isSilent);
        return { context, stored };
      }

      const jobNote = await addContext(jobTicketCode, 'Silent job note');
      const taskNote = await addContext(taskState.ticket_code, 'Silent task note');
      assert.strictEqual(taskNote.stored.associated_comment_id, task.id);
      for (const note of [jobNote, taskNote]) {
        assert.strictEqual(note.stored.created_by, aiUserId);
        const received = await aiWebSocketRunner.waitForReceivedMessage({
          event_type: 'poke_ai', message: `Added ${note.context.short_code_id} of ${jobTicketCode}`
        }, MESSAGE_TIMEOUT_MS);
        assertPokeEnvelope(received);
      }

      const capsuleCodes = [];
      for (const taskCode of [undefined, taskState.ticket_code]) {
        const response = await mcpCall(adminConfiguration, uclusionToken, 'set_design_capsule', {
          job_id: jobTicketCode, ...(taskCode ? { task_id: taskCode } : {}),
          capsule: `## Outcome\nSilent context capsule ${taskCode || jobTicketCode} ${marker}`
        });
        const result = JSON.parse(response).result;
        assert(result && !result.isError, `Capsule write failed: ${response}`);
        capsuleCodes.push(result.structuredContent.capsule_short_code_id);
      }
      for (const capsuleCode of capsuleCodes) {
        const reply = await addContext(capsuleCode, `Silent capsule comment ${capsuleCode}`);
        assert.strictEqual(reply.stored.created_by, aiUserId);
        assert(reply.context.short_code_id.startsWith('C-'));
        assertPokeEnvelope(await aiWebSocketRunner.waitForReceivedMessage({
          event_type: 'poke_ai', message: `Added ${reply.context.short_code_id} of ${jobTicketCode}`
        }, MESSAGE_TIMEOUT_MS));
        const nested = await addContext(reply.context.short_code_id, `Silent nested comment ${capsuleCode}`);
        assertPokeEnvelope(await aiWebSocketRunner.waitForReceivedMessage({
          event_type: 'poke_ai', message: `Added ${nested.context.short_code_id} of ${jobTicketCode}`
        }, MESSAGE_TIMEOUT_MS));
        await assertNoPoke({ event_type: 'poke_ai', message: `Updated ${capsuleCode} of ${jobTicketCode}` },
          BASELINE_QUIET_WINDOW_MS, 'Parent-only capsule version changes must not create a second Poke');
      }

      const suppressed = [
        await addContext(jobTicketCode, 'Nonsilent AI note', false),
        await addContext(jobNote.context.short_code_id, 'Silent ordinary-note reply'),
        await addContext(capsuleCodes[0], 'Nonsilent capsule comment', false),
        await addContext(jobTicketCode, 'Silent human-attributed note', true,
          { for_human: true, is_my_lane: true })
      ];
      assert.strictEqual(suppressed[3].stored.created_by, adminId);
      for (const write of suppressed) {
        await assertNoPoke({
          event_type: 'poke_ai', message: `Added ${write.context.short_code_id} of ${jobTicketCode}`
        }, DUPLICATE_QUIET_WINDOW_MS, 'Other AI writes must retain their existing echo suppression');
      }
    }).timeout(600000);

    it('should name the new type when a human moves a suggestion to a task', async () => {
      // B-all-703: the task keeps its S- code, so the Poke says what it became and the
      // agent need not reread it. The web UI's Move to task sends only the new type.
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const suggestionMarker = `Human suggestion to move to a task ${marker}`;
      const suggestion = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        suggestionMarker,
        null,
        'SUGGEST'
      );
      const persistedSuggestion = suggestion.ticket_code
        ? suggestion
        : await findCommentByMarker(adminClient, marketId, suggestionMarker);
      assert(persistedSuggestion?.ticket_code, 'Human-created suggestion should have a ticket code');

      const convertedPromise = aiWebSocketRunner.waitForReceivedMessage({
        event_type: 'poke_ai',
        message: `Updated ${persistedSuggestion.ticket_code} of ${jobTicketCode} converted to task`
      }, MESSAGE_TIMEOUT_MS);
      const task = await adminClient.investibles.updateComment(persistedSuggestion.id, undefined,
        undefined, undefined, undefined, 'TODO', undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, 'America/Los_Angeles');
      assert.strictEqual(task.comment_type, 'TODO', 'Move to task should store a task');
      assert.strictEqual(task.ticket_code, persistedSuggestion.ticket_code,
        'Move to task keeps the suggestion short code');
      assertPokeEnvelope(await convertedPromise);
    }).timeout(240000);

    it('suppresses task-to-bug conversion until the new canonical bug has a subscriber', async () => {
      // B-all-703: the web UI's Move to bug only sets a severity, which takes the task out
      // of its job, so the stored type stays a task and only the job membership changes.
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const taskMarker = `Human task to move to a bug ${marker}`;
      const task = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        taskMarker,
        null,
        'TODO'
      );
      const persistedTask = task.ticket_code
        ? task
        : await findCommentByMarker(adminClient, marketId, taskMarker);
      assert(persistedTask?.ticket_code, 'Human-created task should have a ticket code');

      const convertedSignature = {
        event_type: 'poke_ai',
        message: `Updated ${persistedTask.ticket_code} of ${jobTicketCode} converted to bug`
      };
      const bug = await adminClient.investibles.alterComment(persistedTask.id, 'RED');
      assert(!bug.investible_id, 'Move to bug should take the task out of its job');
      assert.strictEqual(bug.ticket_code, persistedTask.ticket_code,
        'Move to bug keeps the task short code');
      await assertNoPoke(convertedSignature, DUPLICATE_QUIET_WINDOW_MS,
        'The former job subscription must not become membership in a new standalone bug');
      assert.deepStrictEqual((await manualRouting(bug.ticket_code, true)).subscriber_agent_ids, []);
      const subscribed = await subscription(bug.ticket_code, fixtureAgentId);
      assert.strictEqual(subscribed.work.kind, 'bug');
      assert.deepStrictEqual((await manualRouting(bug.ticket_code)).subscriber_agent_ids, [fixtureAgentId]);
    }).timeout(240000);

    it('should defer a blocker Added event until the job is Blocked and causally readable', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const doableStage = planningStages.find((stage) => stage.name === 'Doable');
      const blockedStage = planningStages.find((stage) => stage.name === 'Blocked');
      assert(doableStage && blockedStage, 'Planning market should include Doable and Blocked');

      const createdMarketInfo = job.market_infos.find((info) => info.market_id === marketId)
        || job.market_infos[0];
      const [currentJob] = await adminClient.markets.getMarketInvestibles([{
        investible: { id: job.investible.id, version: 1 },
        market_infos: [{ id: createdMarketInfo.id, version: 1 }]
      }]);
      const currentMarketInfo = currentJob.market_infos.find(
        (info) => info.market_id === marketId
      ) || currentJob.market_infos[0];
      if (currentMarketInfo.stage !== doableStage.id) {
        const updatedPromise = aiWebSocketRunner.waitForReceivedMessage({
          event_type: 'poke_ai',
          message: `Updated ${jobTicketCode} stage is now Doable`
        }, MESSAGE_TIMEOUT_MS);
        await adminClient.investibles.stateChange(job.investible.id, {
          current_stage_id: currentMarketInfo.stage,
          stage_id: doableStage.id
        });
        const updated = await updatedPromise;
        assertPokeEnvelope(updated);
      }

      const blockerMarker = `Human dependency blocker ${marker}`;
      const blocker = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        blockerMarker,
        null,
        'ISSUE'
      );
      const persistedBlocker = blocker.ticket_code
        ? blocker
        : await findCommentByMarker(adminClient, marketId, blockerMarker);
      assert(persistedBlocker?.ticket_code, 'Blocker should have a short code');

      const addedSignature = {
        event_type: 'poke_ai',
        // J-all-380: a comment on a job pokes with its enclosing job as parent
        message: `Added ${persistedBlocker.ticket_code} of ${jobTicketCode}`
      };
      const added = await aiWebSocketRunner.waitForReceivedMessage(
        addedSignature,
        MESSAGE_TIMEOUT_MS
      );
      assertPokeEnvelope(added);

      const jobMarkdown = await mcpCall(
        adminConfiguration,
        uclusionToken,
        'get_job',
        { short_code_id: persistedBlocker.ticket_code }
      );
      assert(jobMarkdown.includes(blockerMarker),
        'Causal get_job should include the blocker that triggered the event');
      assert(jobMarkdown.includes(blockedStage.name),
        'Causal get_job should render the stage triggered by the blocker');

      const blockedInvestibles = await pollFor(
        () => adminClient.markets.getMarketInvestibles([{
          investible: { id: job.investible.id, version: 1 },
          market_infos: [{ id: createdMarketInfo.id, version: 1 }]
        }]),
        (fetched) => fetched?.[0]?.market_infos?.some(
          (info) => info.market_id === marketId && info.stage === blockedStage.id
        )
      );
      assert(
        blockedInvestibles?.[0]?.market_infos?.some(
          (info) => info.market_id === marketId && info.stage === blockedStage.id
        ),
        'Blocker Added should not arrive before the job reaches Blocked'
      );

      await assertNoPoke(
        addedSignature,
        DUPLICATE_QUIET_WINDOW_MS,
        'Derived stage processing should not deliver the blocker Added twice'
      );
      await Promise.all([
        `Updated ${jobTicketCode}`,
        `Updated ${jobTicketCode} stage is now Blocked`
      ].map((message) => assertNoPoke(
        { event_type: 'poke_ai', message },
        DUPLICATE_QUIET_WINDOW_MS,
        'The blocker-derived stage change should not emit a second job event'
      )));
    }).timeout(360000);

    it('should emit description-change Updated when a human edits a collaborated job description', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const updatedSignature = {
        event_type: 'poke_ai',
        message: `Updated ${jobTicketCode} description change`
      };
      const locked = await adminClient.investibles.lock(job.investible.id);
      await assertNoPoke(
        updatedSignature,
        BASELINE_QUIET_WINDOW_MS,
        'No stale Updated event should be queued before the description mutation'
      );
      const updatedPromise = aiWebSocketRunner.waitForReceivedMessage(
        updatedSignature, MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.update(
        job.investible.id,
        locked.investible.name,
        `Human-updated description for existing AI collaborator ${marker}.`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        locked.investible.version
      );
      const updated = await updatedPromise;
      assertPokeEnvelope(updated);
    }).timeout(240000);

    it('should emit one Updated for each assignment on a collaborated job', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode, aiUserId } = await createCollaboratedJob(marker);
      const updatedSignature = {
        event_type: 'poke_ai',
        message: `Updated ${jobTicketCode}`
      };
      await assertNoPoke(
        updatedSignature,
        BASELINE_QUIET_WINDOW_MS,
        'No stale Updated event should be queued before the assignment mutation'
      );
      const updatedPromise = aiWebSocketRunner.waitForReceivedMessage(
        updatedSignature, MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.updateAssignments(job.investible.id, [aiUserId]);
      const updated = await updatedPromise;
      assertPokeEnvelope(updated);
      await assertNoPoke(
        updatedSignature,
        DUPLICATE_QUIET_WINDOW_MS,
        `Assignment Updated should not be delivered twice within ${DUPLICATE_QUIET_WINDOW_MS}ms`
      );
      const reassignedPromise = aiWebSocketRunner.waitForReceivedMessage(
        updatedSignature, MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.updateAssignments(job.investible.id, [adminId]);
      const reassigned = await reassignedPromise;
      assertPokeEnvelope(reassigned);
      await assertNoPoke(
        updatedSignature,
        DUPLICATE_QUIET_WINDOW_MS,
        `A later assignment Updated should not be delivered twice`
      );
    }).timeout(360000);

    it('should not emit Updated for a job without an AI collaborator', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `No AI collaborator ${marker}`,
        description: 'Fresh human-authored job with no AI comments, replies, votes, or approvals.'
      });
      const jobTicketCode = await getTicketCode(job);
      await subscription(jobTicketCode, fixtureAgentId);
      const updatedSignature = {
        event_type: 'poke_ai',
        message: `Updated ${jobTicketCode} description change`
      };
      const locked = await adminClient.investibles.lock(job.investible.id);
      await assertNoPoke(
        updatedSignature,
        BASELINE_QUIET_WINDOW_MS,
        'Fresh job creation and locking should not queue Updated without AI collaboration'
      );
      const noUpdatedPromise = aiWebSocketRunner.waitForReceivedMessage(
        updatedSignature, DUPLICATE_QUIET_WINDOW_MS);
      await adminClient.investibles.update(
        job.investible.id,
        locked.investible.name,
        `Human-updated description without AI collaboration ${marker}.`,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        locked.investible.version
      );
      await assert.rejects(
        noUpdatedPromise,
        (error) => error.code === WEBSOCKET_TIMEOUT_CODE,
        `Description edit should not emit Updated within ${DUPLICATE_QUIET_WINDOW_MS}ms`
      );
    }).timeout(240000);
  });
}
