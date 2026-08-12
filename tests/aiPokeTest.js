import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarket,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { WebSocketRunner } from '../src/WebSocketRunner.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

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

    async function createCollaboratedJob(marker) {
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `AI collaborator event ${marker}`,
        description: 'Job used to verify response-worthy changes wake an existing AI collaborator.',
        assignments: [adminId]
      });
      const jobTicketCode = await getTicketCode(job);
      const collaboratorMarker = `AI collaborator note ${marker}`;
      const mcpResult = await pollMcp('add_info', {
        short_code_id: jobTicketCode,
        info: collaboratorMarker
      });
      assert(mcpResult.includes('Added info with id'),
        `MCP add_info response wrong: ${mcpResult}`);
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
      const firstMarker = `First AI question of a pair ${marker}?`;
      const secondMarker = `Second AI question of a pair ${marker}?`;
      const firstResult = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: firstMarker
      });
      assert(firstResult.includes('Added question with id'),
        `MCP ask_question response wrong: ${firstResult}`);
      const secondResult = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: secondMarker
      });
      assert(secondResult.includes('Added question with id'),
        `MCP ask_question response wrong: ${secondResult}`);
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
        'The job-unblocking target must wait for the second answer'
      );

      const jobRespondedPromise = aiWebSocketRunner.waitForReceivedMessage(
        { event_type: 'poke_ai', message: `Responded ${jobTicketCode}` },
        MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        `Answer to the second question ${marker}.`,
        secondQuestion.id
      );
      assertPokeEnvelope(await jobRespondedPromise);

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
      // Standalone market-level TODOs do not emit Added — that path is for
      // investible-attached tasks when AI already collaborates. Collaboration
      // for the later Responded hand-backs comes from createCollaboratedJob
      // plus the AI completion note below.

      const completionMarker = `AI completion note for both-poke ${marker}`;
      const mcpInfo = await pollMcp('add_info', {
        short_code_id: bugTicketCode,
        info: completionMarker
      });
      assert(mcpInfo.includes('Added info with id'),
        `MCP add_info response wrong: ${mcpInfo}`);
      const completion = await findCommentByMarker(
        adminClient, marketId, completionMarker);
      assert(completion, 'AI completion note should be discoverable');
      assert.notStrictEqual(completion.created_by, adminId,
        'MCP add_info comment should be authored by the market AI user');

      const mcpResolve = await pollMcp('resolve', {
        short_code_id: bugTicketCode
      });
      assert(mcpResolve.includes('Resolved'),
        `MCP resolve response wrong: ${mcpResolve}`);
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

      const replyPromise = aiWebSocketRunner.waitForReceivedMessage(
        respondedSignature, MESSAGE_TIMEOUT_MS);
      await adminClient.investibles.createComment(
        undefined,
        marketId,
        `Also do X after reopen ${marker}`,
        persistedBug.id
      );
      const replyPoke = await replyPromise;
      assertPokeEnvelope(replyPoke);

      const secondReplyPromise = aiWebSocketRunner.waitForReceivedMessage(
        respondedSignature, DUPLICATE_QUIET_WINDOW_MS);
      await adminClient.investibles.createComment(
        undefined,
        marketId,
        `Even more direction after reopen ${marker}`,
        persistedBug.id
      );
      await assert.rejects(
        secondReplyPromise,
        (error) => error.code === WEBSOCKET_TIMEOUT_CODE,
        'A second consecutive human reply after reopen should stay silent until AI acts'
      );
    }).timeout(360000);

    it('should emit one compound Responded poke for a human question inside an AI option', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Nested option response ${marker}`,
        description: 'Job whose AI-authored question receives a human question inside its option.'
      });
      const jobTicketCode = await getTicketCode(job);
      const parentMarker = `AI parent question with an option ${marker}?`;
      const mcpResult = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: parentMarker,
        options: [{
          name: `Option ${marker}`,
          description: 'Option whose discussion receives the nested human question.'
        }]
      });
      assert(mcpResult.includes('Added question with id'),
        `MCP ask_question response wrong: ${mcpResult}`);

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
          message: `Updated ${jobTicketCode}`
        }, MESSAGE_TIMEOUT_MS);
        await adminClient.investibles.stateChange(job.investible.id, {
          current_stage_id: currentMarketInfo.stage,
          stage_id: doableStage.id
        });
        const updated = await updatedPromise;
        assertPokeEnvelope(updated);
      }

      const blockerMarker = `Human blocker forcing Blocked ${marker}`;
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
      assert(jobMarkdown.includes('This job is in stage Blocked.'),
        'Causal get_job should include the current Blocked stage');

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
      await assertNoPoke(
        {
          event_type: 'poke_ai',
          message: `Updated ${jobTicketCode}`
        },
        DUPLICATE_QUIET_WINDOW_MS,
        'The blocker-derived stage change should not emit a second job event'
      );
    }).timeout(360000);

    it('should emit Updated when a human edits a collaborated job description', async () => {
      const marker = randomUUID();
      const { job, jobTicketCode } = await createCollaboratedJob(marker);
      const updatedSignature = {
        event_type: 'poke_ai',
        message: `Updated ${jobTicketCode}`
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
      const updatedSignature = {
        event_type: 'poke_ai',
        message: `Updated ${jobTicketCode}`
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
