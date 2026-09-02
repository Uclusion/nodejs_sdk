import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketInvite
} from '../src/utils.js';
import { WebSocketRunner } from '../src/WebSocketRunner.js';
import { mcpCall, mcpLogin, pollFor, sleep } from './commonTestFunctions.js';

const DATA_PUSH_QUIET_WINDOW_MS = 15000;
const WEBSOCKET_TIMEOUT_CODE = 'WEBSOCKET_MESSAGE_TIMEOUT';

/**
 * T-all-2484: a question created with options produced two inbox rows, an UNREAD_COMMENT on the
 * question comment on top of the NOT_FULLY_VOTED on its inline decision market. Which one you saw
 * depended on whether the comment handler or send_inline_notifications ran first, which is why a
 * burst exposed it and single questions usually did not.
 *
 * uclusion_async 5277ecc did not make that race safe, it removed one of the racers: a newly created
 * comment already carrying an inline_holder returns early and lets the inline market update do the
 * notifying. Only one producer remains, so the symptom is now a deterministic invariant and this
 * test asserts the invariant rather than trying to reproduce a race.
 */
export default function (adminConfiguration, userConfiguration) {
  describe('#test inline question does not double notify', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
    let adminId;
    let uclusionToken;
    let doableStage;
    let requiresInputStage;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const response = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = response.client;
      accountToken = response.accountToken;
      const result = await accountClient.markets.createMarket({
        name: 'Inline duplicate notifications',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      doableStage = result.stages.find((stage) => stage.name === 'Doable');
      requiresInputStage = result.stages.find((stage) => stage.name === 'Requires Input');
      assert(doableStage && requiresInputStage,
        'Planning market must include Doable and Requires Input stages');
      adminClient = await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      adminId = (await adminClient.users.get()).id;
      // The market-scoped token the CLI proxy uses.
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
    });

    // The one row a question with options must never produce, as its own predicate so the
    // assertion below and the check that it works cannot drift apart.
    function namesComment(message, commentId) {
      return Boolean(message.type_object_id?.startsWith('UNREAD_COMMENT') &&
        message.type_object_id.includes(commentId));
    }

    // The SDK rejects with the raw fetch Response, which mocha renders as
    // `the response {"size":0,"timeout":0} was thrown` and hides the API's own message. Unwrap it
    // so a failure here says what the backend actually objected to.
    async function reportingHttpErrors(run) {
      try {
        return await run();
      } catch (error) {
        if (error && typeof error.text === 'function') {
          const body = await error.text();
          throw new Error(`HTTP ${error.status} ${error.url} :: ${body.slice(0, 500)}`);
        }
        throw error;
      }
    }

    // The AI user is created async on market creation, so retry until the tool answers.
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

    async function waitForSubscription(webSocketRunner) {
      let lastTimeout;
      // subscribe has no acknowledgement. A pong proves the subscription row can be found for
      // this connection, so retry ping while its eventually-consistent index catches up.
      for (let i = 0; i < 12; i += 1) {
        try {
          await webSocketRunner.waitForOpen();
          const pongPromise = webSocketRunner.waitForReceivedMessage({ event_type: 'pong' }, 5000);
          // If the connection closes between waitForOpen and send, this waiter will time out after
          // the retry has moved on. Attach a handler now so that timeout is never unhandled.
          pongPromise.catch(() => {});
          webSocketRunner.send('ping');
          await pongPromise;
          return;
        } catch (error) {
          const closedBeforePing = error.message === 'Cannot send because websocket is not open';
          if (error.code !== WEBSOCKET_TIMEOUT_CODE && !closedBeforePing) {
            throw error;
          }
          lastTimeout = error;
        }
      }
      throw lastTimeout;
    }

    async function getTicketCode(investibleId, marketInfoId) {
      const ticketCode = await pollFor(async () => {
        const fetched = await adminClient.markets.getMarketInvestibles([{
          investible: { id: investibleId, version: 1 },
          market_infos: [{ id: marketInfoId, version: 1 }]
        }]);
        return fetched?.[0]?.market_infos?.[0]?.ticket_code;
      }, (code) => code);
      assert(ticketCode, `Ticket code missing for ${investibleId}`);
      return ticketCode;
    }

    async function listMarketComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || []).find((entry) => entry.market_id === marketId);
      const commentVersions = new Map();
      (marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const current = commentVersions.get(version.object_id_one) || 0;
          commentVersions.set(version.object_id_one, Math.max(current, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return adminClient.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    async function findQuestionByMarker(marker) {
      const comments = await pollFor(
        listMarketComments,
        (fetched) => fetched.some((comment) => comment.body?.includes(marker) &&
          comment.inline_market_id));
      const question = comments.find((comment) => comment.body?.includes(marker));
      assert(question, `Question with marker ${marker} never appeared`);
      assert(question.inline_market_id,
        `Question ${marker} has no inline market, so it cannot exercise this at all`);
      return question;
    }

    async function getJobMarketInfo(job) {
      const marketInfo = job.market_infos[0];
      const fetched = await adminClient.markets.getMarketInvestibles([{
        investible: { id: job.investible.id, version: 1 },
        market_infos: [{ id: marketInfo.id, version: 1 }]
      }]);
      return fetched?.[0]?.market_infos?.find((info) => info.id === marketInfo.id);
    }

    async function createJob(name, targetStage) {
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name,
        description: 'Job to hang the AI authored question on.',
        // Without an assignee the job has no followers, and investible_comment_changed_common's
        // notify loop skips updated_by, so nothing is notified and an absence assertion below
        // would pass for the wrong reason.
        assignments: [adminId]
      });
      const marketInfo = job.market_infos[0];
      const ticketCode = marketInfo.ticket_code ||
        await getTicketCode(job.investible.id, marketInfo.id);
      if (targetStage && marketInfo.stage !== targetStage.id) {
        await adminClient.investibles.stateChange(job.investible.id, {
          current_stage_id: marketInfo.stage,
          stage_id: targetStage.id
        });
      }
      const currentMarketInfo = await pollFor(
        () => getJobMarketInfo(job),
        (info) => info?.stage === (targetStage?.id || marketInfo.stage));
      assert(currentMarketInfo, `Market info missing for ${job.investible.id}`);
      if (targetStage) {
        assert.strictEqual(currentMarketInfo.stage, targetStage.id,
          `Job ${job.investible.id} did not reach ${targetStage.name}`);
      }
      return { job, marketInfo: currentMarketInfo, ticketCode };
    }

    function askQuestion(jobTicket, marker) {
      return pollMcp('ask_question', {
        job_id: jobTicket,
        question: marker,
        options: [
          { name: 'First direction', description: 'One way to go.' },
          { name: 'Second direction', description: 'Another way to go.' }
        ]
      });
    }

    it('creates one notification for a question with options, not two', async function () {
      this.timeout(300000);
      await reportingHttpErrors(async () => {
        const marker = `Single inline question ${randomUUID()}?`;
        const { ticketCode } = await createJob('Inline dup single');
        const asked = await askQuestion(ticketCode, marker);
        assert(asked.includes('Added question with id'), `MCP ask_question response wrong: ${asked}`);

        const question = await findQuestionByMarker(marker);
        const inlineMarketId = question.inline_market_id;

        // The AI authors the question, so the admin is the recipient.
        const messages = await pollFor(
          async () => (await getMessages(adminConfiguration)) || [],
          (fetched) => fetched.some((message) =>
            message.type_object_id === `NOT_FULLY_VOTED_${inlineMarketId}`));

        const callsToVote = messages.filter((message) =>
          message.type_object_id === `NOT_FULLY_VOTED_${inlineMarketId}`);
        assert.strictEqual(callsToVote.length, 1,
          `Expected exactly one call to vote for ${inlineMarketId}: ${JSON.stringify(callsToVote)}`);

        // This is the assertion that pins the fix. Before uclusion_async 5277ecc the comment handler
        // also notified, so this row could sit on top of the one above.
        const unreadComment = messages.filter((message) => namesComment(message, question.id));
        assert.strictEqual(unreadComment.length, 0,
          `A question with options must not also raise UNREAD_COMMENT: ${
            JSON.stringify(unreadComment)}`);
      });
    });

    // The absence assertion above is only meaningful if the matcher it uses is capable of
    // matching. A live control, asking a question with no options and expecting its
    // UNREAD_COMMENT, turned out not to be reproducible on dev: the row appeared within five
    // seconds on one run and never within thirty on an identical one, so it would have shipped
    // as a flaky test. This asserts the same property deterministically instead. The format was
    // confirmed against dev: type_object_id is UNREAD_COMMENT_<commentId>.
    it('uses a matcher that really does match an UNREAD_COMMENT row', () => {
      const commentId = 'b390fa5b-9616-495c-a887-a9a98a41fa4e';
      assert(namesComment({ type_object_id: `UNREAD_COMMENT_${commentId}` }, commentId),
        'The matcher must match the row the with-options case forbids');
      assert(!namesComment({ type_object_id: `NOT_FULLY_VOTED_${commentId}` }, commentId),
        'The matcher must not treat a call to vote as a comment notification');
      assert(!namesComment({ type_object_id: 'UNREAD_COMMENT_00000000-0000-0000-0000-000000000000' },
        commentId), 'The matcher must not match a different comment');
    });

    // The live control, restored. It failed on an earlier version of this file whose market held
    // only the admin, because the notify loop skips updated_by and there was then nobody left to
    // notify - which made the absence asserted above meaningless, since it could have been caused
    // by nothing being notified at all rather than by the fix. With a second human present the
    // same market must produce this row for an options-less question, which is what gives the
    // absence above its meaning.
    it('still raises UNREAD_COMMENT for a question with no options', async function () {
      this.timeout(300000);
      await reportingHttpErrors(async () => {
        const marker = `Plain question ${randomUUID()}?`;
        const { ticketCode } = await createJob('Inline dup control');
        const asked = await pollMcp('ask_question', { job_id: ticketCode, question: marker });
        assert(asked.includes('Added question with id'), `MCP ask_question response wrong: ${asked}`);

        const comments = await pollFor(listMarketComments,
          (fetched) => fetched.some((comment) => comment.body?.includes(marker)));
        const question = comments.find((comment) => comment.body?.includes(marker));
        assert(question, `Control question ${marker} never appeared`);
        assert(!question.inline_market_id, 'A question with no options should have no inline market');

        const messages = await pollFor(
          async () => (await getMessages(adminConfiguration)) || [],
          (fetched) => fetched.some((message) => namesComment(message, question.id)));
        const mine = messages.filter((message) => message.market_id === marketId)
          .map((message) => message.type_object_id);
        assert.strictEqual(messages.filter((message) => namesComment(message, question.id)).length, 1,
          `A question with no options must raise UNREAD_COMMENT for comment ${question.id}. `
          + `Rows in this market: ${JSON.stringify(mine)}`);
      });
    });

    it('creates one notification per question when several are asked at once', async function () {
      this.timeout(600000);
      await reportingHttpErrors(async () => {
        // T-all-2484's own words are that seven questions should be seven rows. Concurrency is what
        // surfaced the defect, so it is worth covering, but this part is timing exposed in a way the
        // assertion above is not. If it ever turns flaky in CI, delete it rather than retry it into
        // stability; the invariant above is what actually guards the notification fix. J-all-429
        // also pins the corrective refresh contract at a comment/job pair per question.
        const runMarker = randomUUID();
        const markers = [1, 2, 3, 4, 5, 6, 7]
          .map((index) => `Concurrent inline question ${index} ${runMarker}?`);
        const jobs = [];
        for (let index = 0; index < markers.length; index += 1) {
          jobs.push(await createJob(`Inline dup concurrent ${index + 1}`, doableStage));
        }

        let captureRunner;
        try {
          captureRunner = new WebSocketRunner({
            wsUrl: adminConfiguration.websocketURL,
            reconnectInterval: 3000
          });
          captureRunner.connect();
          captureRunner.subscribe(accountToken);
          await captureRunner.waitForOpen();
          await waitForSubscription(captureRunner);

          const receivedPayloads = [];
          const capturedVersionSnapshots = [];
          let captureConnectionClosed = false;
          // Reconnection is useful while establishing the subscription, but losing the socket
          // during measurement creates an unobservable gap and invalidates the exact-count claim.
          captureRunner.socket.onclose = () => {
            captureConnectionClosed = true;
          };
          captureRunner.messageHanders.push((payload) => {
            receivedPayloads.push(payload);
            if (payload.object_id === marketId &&
              (payload.event_type === 'comment' || payload.event_type === 'market_investible') &&
              typeof payload.version === 'number' &&
              typeof payload.object_id_one_two === 'string') {
              const versionsPromise = accountClient.summaries.versions(accountToken, [marketId]);
              // The websocket callback cannot await. Observe rejection immediately, then retain the
              // original promise so the assertion below still reports the API failure.
              versionsPromise.catch(() => {});
              capturedVersionSnapshots.push({ payload, versionsPromise });
            }
            return false;
          });

          await Promise.all(jobs.map((created, index) =>
            askQuestion(created.ticketCode, markers[index])));

          const questions = [];
          for (const marker of markers) {
            questions.push(await findQuestionByMarker(marker));
          }
          const inlineMarketIds = questions.map((question) => question.inline_market_id);

          const isStructuralVersionFrame = (payload) =>
            payload.event_type !== 'notification' && payload.event_type !== 'pong' &&
            typeof payload.version === 'number' && typeof payload.object_id_one_two === 'string';
          const isForQuestion = (payload, question, created) => {
            if (!isStructuralVersionFrame(payload)) {
              return false;
            }
            if (payload.object_id === question.inline_market_id) {
              return true;
            }
            if (payload.object_id !== marketId) {
              return false;
            }
            if (payload.event_type === 'comment') {
              return payload.object_id_one_two === question.id;
            }
            if (payload.event_type === 'investment') {
              return payload.object_id_one_two ===
                `${created.marketInfo.id}_${question.created_by}`;
            }
            return payload.event_type === 'market_investible' &&
              payload.object_id_one_two ===
                `${created.marketInfo.id}_${created.job.investible.id}` &&
              payload.version > created.marketInfo.version;
          };
          await pollFor(
            async () => receivedPayloads.filter((payload) =>
              questions.some((question, index) => isForQuestion(payload, question, jobs[index]))),
            (frames) => frames.length >= markers.length * 2);

          const messages = await pollFor(
            async () => (await getMessages(adminConfiguration)) || [],
            (fetched) => inlineMarketIds.every((inlineMarketId) => fetched.some((message) =>
              message.type_object_id === `NOT_FULLY_VOTED_${inlineMarketId}`)));

          inlineMarketIds.forEach((inlineMarketId) => {
            const callsToVote = messages.filter((message) =>
              message.type_object_id === `NOT_FULLY_VOTED_${inlineMarketId}`);
            assert.strictEqual(callsToVote.length, 1,
              `Expected exactly one call to vote for ${inlineMarketId}`);
          });
          const strays = messages.filter((message) =>
            message.type_object_id?.startsWith('UNREAD_COMMENT') &&
            questions.some((question) => message.type_object_id.includes(question.id)));
          assert.strictEqual(strays.length, 0,
            `Questions asked together must still be one row each: ${JSON.stringify(strays)}`);

          await sleep(DATA_PUSH_QUIET_WINDOW_MS);
          assert.strictEqual(captureConnectionClosed, false,
            'Websocket closed during data-refresh capture; exact push count is unknowable');
          const relevantFrames = receivedPayloads.filter((payload) =>
            questions.some((question, index) => isForQuestion(payload, question, jobs[index])));
          assert.strictEqual(relevantFrames.length, markers.length * 2,
            `Expected exactly ${markers.length * 2} correlated data refreshes: ${
              JSON.stringify(relevantFrames)}`);
          for (let index = 0; index < questions.length; index += 1) {
            const question = questions[index];
            const created = jobs[index];
            const frames = relevantFrames.filter((payload) =>
              isForQuestion(payload, question, created));
            assert.strictEqual(frames.length, 2,
              `Expected a comment/job refresh pair for question ${question.id}, job ${
                created.job.investible.id}, and inline market ${
                question.inline_market_id}: ${JSON.stringify(frames)}`);
            assert.deepStrictEqual(frames.map((frame) => frame.event_type).sort(),
              ['comment', 'market_investible'],
              `Expected an unordered comment/job pair for question ${question.id}: ${
                JSON.stringify(frames)}`);

            const commentFrame = frames.find((frame) => frame.event_type === 'comment');
            const jobFrame = frames.find((frame) => frame.event_type === 'market_investible');
            assert.strictEqual(commentFrame.object_id, marketId,
              `The question refresh must belong to planning market ${marketId}`);
            assert.strictEqual(commentFrame.object_id_one_two, question.id,
              `The question refresh must name comment ${question.id}`);
            assert.strictEqual(commentFrame.version, question.version,
              `The question refresh must be published version ${question.version}`);
            assert.strictEqual(jobFrame.object_id, marketId,
              `The job refresh must belong to planning market ${marketId}`);
            assert.strictEqual(jobFrame.object_id_one_two,
              `${created.marketInfo.id}_${created.job.investible.id}`,
              `The corrective refresh must name job ${created.job.investible.id}`);
            assert(jobFrame.version > created.marketInfo.version,
              `The corrective refresh must advance job ${created.job.investible.id}`);

            const snapshots = capturedVersionSnapshots.filter(({ payload }) =>
              isForQuestion(payload, question, created));
            assert.strictEqual(snapshots.length, 2,
              `Each correlated frame must start a versions snapshot for question ${question.id}`);
            const versions = await snapshots[1].versionsPromise;
            const marketEntry = (versions.signatures || [])
              .find((entry) => entry.market_id === marketId);
            const commentVersion = (marketEntry?.signatures || [])
              .filter((signature) => signature.type === 'comment')
              .flatMap((signature) => signature.object_versions || [])
              .find((version) => version.object_id_one === question.id &&
                version.version === commentFrame.version);
            const jobVersion = (marketEntry?.signatures || [])
              .filter((signature) => signature.type === 'market_investible')
              .flatMap((signature) => signature.object_versions || [])
              .find((version) => version.object_id_one === created.marketInfo.id &&
                version.object_id_two === created.job.investible.id &&
                version.version === jobFrame.version);
            assert(commentVersion,
              `Second-frame snapshot must contain comment signature ${question.id} v${
                commentFrame.version}`);
            assert(jobVersion,
              `Second-frame snapshot must contain job signature ${created.marketInfo.id}_${
                created.job.investible.id} v${jobFrame.version}`);

            const comments = await adminClient.investibles.getMarketComments([{
              id: commentVersion.object_id_one,
              version: commentVersion.version
            }]);
            const sentQuestion = comments.find((comment) => comment.id === question.id);
            assert(sentQuestion, `Snapshot question ${question.id} must hydrate`);
            assert.strictEqual(sentQuestion.is_sent, true,
              `Snapshot question ${question.id} must be sent`);
            assert(sentQuestion.body?.includes(markers[index]),
              `Snapshot question ${question.id} must contain its marker`);

            const hydratedJobs = await adminClient.markets.getMarketInvestibles([{
              investible: {
                id: created.job.investible.id,
                version: created.job.investible.version
              },
              market_infos: [{ id: jobVersion.object_id_one, version: jobVersion.version }]
            }]);
            const hydratedMarketInfo = hydratedJobs[0]?.market_infos
              ?.find((info) => info.id === created.marketInfo.id);
            assert(hydratedMarketInfo,
              `Snapshot job ${created.job.investible.id} must hydrate`);
            assert.strictEqual(hydratedMarketInfo.stage, requiresInputStage.id,
              `Snapshot job ${created.job.investible.id} must be Requires Input`);
          }
        } finally {
          if (captureRunner) {
            captureRunner.terminate();
          }
        }
      });
    });
  });
}
