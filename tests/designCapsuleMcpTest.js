import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, pollFor, sleep } from './commonTestFunctions.js';
import {
  deleteIntegrationTestMarket,
  INTEGRATION_TEST_SUB_TYPE
} from './jobAuditMcpTest.js';

const CAPSULE_HEADING = '#### Current intent/design capsule';

export default function (adminConfiguration) {
  describe('#test intent/design capsule MCP integration (J-Marketing-33)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let adminId;
    let marketId;
    let uclusionToken;

    before(async function () {
      this.timeout(300000);
      // The full runner creates this identity in usersTest; retain standalone execution.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      accountToken = accountLogin.accountToken;
      const createdMarket = await accountClient.markets.createMarket({
        name: 'Intent design capsule MCP integration',
        market_type: 'PLANNING'
      });
      marketId = createdMarket.market.id;
      assert.strictEqual(createdMarket.market.market_sub_type, INTEGRATION_TEST_SUB_TYPE,
        'Capsule fixture was not marked for guarded deletion');
      await loginUserToMarketInvite(adminConfiguration, createdMarket.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      adminId = (await adminClient.users.get()).id;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
    });

    after(async function () {
      this.timeout(300000);
      if (marketId) {
        await deleteIntegrationTestMarket(adminConfiguration, marketId);
      }
    });

    async function retryMcp(toolName, args) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          return await mcpCall(adminConfiguration, uclusionToken, toolName, args);
        } catch (error) {
          if (attempt === 9) {
            throw error;
          }
          await sleep(3000);
        }
      }
      assert.fail(`MCP ${toolName} retry loop ended unexpectedly`);
    }

    function toolResult(response) {
      const envelope = JSON.parse(response);
      assert(envelope.result, `MCP response has no tool result: ${response}`);
      return envelope.result;
    }

    function toolText(response) {
      const result = toolResult(response);
      return (result.content || []).map((item) => item.text || '').join('\n');
    }

    function structuredResult(response) {
      const result = toolResult(response);
      assert.notStrictEqual(result.isError, true, `MCP tool was refused: ${toolText(response)}`);
      const payload = result.structuredContent || JSON.parse(toolText(response));
      assert(payload && typeof payload === 'object', `Expected structured result: ${response}`);
      return payload;
    }

    function assertRefusal(response, ...expectedText) {
      const result = toolResult(response);
      const text = toolText(response);
      assert.strictEqual(result.isError, true, `Expected a tool refusal: ${response}`);
      assert(text.includes('set_design_capsule was refused:'),
        `Refusal should identify set_design_capsule: ${response}`);
      expectedText.forEach((expected) => {
        assert(text.includes(expected), `Refusal should include "${expected}": ${response}`);
      });
    }

    async function listComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === marketId);
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

    async function waitForComments(isDone) {
      return pollFor(listComments, isDone, 40, 3000);
    }

    async function commentCode(comment) {
      if (comment.ticket_code) {
        return comment.ticket_code;
      }
      const comments = await waitForComments((items) =>
        items.some((item) => item.id === comment.id && item.ticket_code));
      const current = comments.find((item) => item.id === comment.id);
      assert(current?.ticket_code, `Short code missing for comment ${comment.id}`);
      return current.ticket_code;
    }

    async function jobCode(job) {
      const marketInfo = job.market_infos.find((info) => info.market_id === marketId)
        || job.market_infos[0];
      if (marketInfo.ticket_code) {
        return marketInfo.ticket_code;
      }
      const ticketCode = await pollFor(async () => {
        const fetched = await adminClient.markets.getMarketInvestibles([{
          investible: { id: job.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        return fetched?.[0]?.market_infos?.find((info) => info.market_id === marketId)?.ticket_code
          || fetched?.[0]?.market_infos?.[0]?.ticket_code;
      }, (value) => value, 20, 3000);
      assert(ticketCode, `Job short code missing for ${job.investible.id}`);
      return ticketCode;
    }

    async function readTarget(shortCode, expectedMarker) {
      const response = await pollFor(
        () => retryMcp('get_job', { short_code_id: shortCode }),
        (candidate) => {
          const markdown = toolText(candidate);
          return markdown.includes(CAPSULE_HEADING) && markdown.includes(expectedMarker);
        },
        20,
        3000
      );
      const markdown = toolText(response);
      assert(markdown.includes(CAPSULE_HEADING) && markdown.includes(expectedMarker),
        `get_job ${shortCode} did not expose its selected capsule marker ${expectedMarker}: ${markdown}`);
      return markdown;
    }

    async function listMcpTools() {
      const response = await fetch(
        adminConfiguration.baseURL.replace('https://', 'https://investibles.') + '/mcp',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: uclusionToken },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        }
      );
      assert(response.ok, `MCP tools/list failed with status ${response.status}`);
      const envelope = await response.json();
      assert(envelope.result?.tools, `MCP tools/list returned no tools: ${JSON.stringify(envelope)}`);
      return envelope.result.tools;
    }

    function capsuleOrder(left, right) {
      const leftKey = [left.updated_at || left.created_at || '', left.version || 0, left.id || ''];
      const rightKey = [right.updated_at || right.created_at || '', right.version || 0, right.id || ''];
      for (let index = 0; index < leftKey.length; index += 1) {
        if (leftKey[index] !== rightKey[index]) {
          return leftKey[index] < rightKey[index] ? 1 : -1;
        }
      }
      return 0;
    }

    function capsuleArchives(comments, sourceCode, sourceVersion) {
      const prefix = `Former intent/design capsule ${sourceCode}, version ${sourceVersion}.`;
      return comments.filter((comment) => comment.body?.includes(prefix));
    }

    function assertArchive(archive, source) {
      assert(archive.ticket_code?.startsWith('R-'),
        `Archive should have its own R code: ${JSON.stringify(archive)}`);
      assert.notStrictEqual(archive.ticket_code, source.ticket_code,
        'Archive must not reuse the capsule R code');
      assert(archive.body.includes(
        `Former intent/design capsule ${source.ticket_code}, version ${source.version}.`));
      assert(archive.body.endsWith(source.body), 'Archive must preserve the complete former body');
      assert.strictEqual(archive.comment_type, 'REPORT');
      assert.strictEqual(archive.notification_type, 'BLUE');
      assert.strictEqual(archive.pinned, false);
      assert.strictEqual(archive.is_visible, false);
      assert.strictEqual(archive.is_machine_only, false);
      assert.strictEqual(archive.is_sent, true);
      assert.strictEqual(archive.created_by, source.created_by);
      assert.strictEqual(archive.investible_id, source.investible_id);
      assert.strictEqual(archive.group_id, source.group_id);
      assert.strictEqual(archive.associated_comment_id, source.associated_comment_id);
      assert.deepStrictEqual(archive.uploaded_files, source.uploaded_files);
    }

    function assertCurrentCapsule(comment, associatedCommentId) {
      assert(comment, 'Current capsule did not synchronize to the human comment stream');
      assert.strictEqual(comment.comment_type, 'REPORT');
      assert.strictEqual(comment.notification_type, 'BLUE');
      assert.strictEqual(comment.pinned, true);
      assert.strictEqual(comment.is_visible, false,
        'Capsule context comes from target selection, not the ordinary Show AI flag');
      assert.strictEqual(comment.is_machine_only, false);
      assert.strictEqual(comment.is_sent, true,
        'A current capsule must be saved for human consumption');
      assert(!comment.reply_id && !comment.root_comment_id, 'A capsule must be a root comment');
      if (associatedCommentId) {
        assert.strictEqual(comment.associated_comment_id, associatedCommentId);
      } else {
        assert(!comment.associated_comment_id, 'A job capsule must remain job-scoped');
      }
    }

    it('creates target-scoped capsules, updates them safely, archives revisions, and converges a create race', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Capsule lifecycle ${marker}`,
        description: 'One job and its tasks must receive independent implementation contracts.',
        assignments: [adminId]
      });
      const jobTicketCode = await jobCode(job);
      const taskMarker = `Capsule target task ${marker}`;
      const task = await adminClient.investibles.createComment(
        job.investible.id, marketId, taskMarker, null, 'TODO');
      const taskTicketCode = await commentCode(task);
      const groupedMarker = `Grouped child target ${marker}`;
      const groupedTask = await adminClient.investibles.createComment(
        job.investible.id, marketId, groupedMarker, task.id);
      const groupedTicketCode = await commentCode(groupedTask);
      assert(groupedTicketCode.startsWith('C-'),
        `Expected an exact grouped C code: ${groupedTicketCode}`);

      const jobV1 = `## Outcome\nJob capsule version one ${marker}.`;
      const taskV1 = `## Outcome\nTask capsule selected through grouped child ${marker}.`;
      const createdJob = structuredResult(await retryMcp('set_design_capsule', {
        job_or_task_id: jobTicketCode,
        capsule: jobV1
      }));
      assert.strictEqual(createdJob.status, 'created');
      assert.strictEqual(createdJob.normalized_target, jobTicketCode);
      assert(createdJob.capsule_short_code_id.startsWith('R-'));
      assert.strictEqual(createdJob.capsule_version, 1);
      assert(createdJob.link.includes(createdJob.capsule_short_code_id));

      const createdTask = structuredResult(await retryMcp('set_design_capsule', {
        job_or_task_id: groupedTicketCode,
        capsule: taskV1
      }));
      assert.strictEqual(createdTask.status, 'created');
      assert.strictEqual(createdTask.normalized_target, taskTicketCode,
        'A grouped C target must normalize to its top-level T');
      assert.strictEqual(createdTask.capsule_version, 1);

      let comments = await waitForComments((items) =>
        [createdJob.capsule_short_code_id, createdTask.capsule_short_code_id]
          .every((code) => items.some((comment) => comment.ticket_code === code)));
      const persistedJobV1 = comments.find((comment) =>
        comment.ticket_code === createdJob.capsule_short_code_id);
      const persistedTaskV1 = comments.find((comment) =>
        comment.ticket_code === createdTask.capsule_short_code_id);
      assertCurrentCapsule(persistedJobV1);
      assertCurrentCapsule(persistedTaskV1, task.id);

      const capsuleReplyMarker = `Task capsule discussion ${marker}`;
      const capsuleReply = await adminClient.investibles.createComment(
        job.investible.id, marketId, capsuleReplyMarker, persistedTaskV1.id);
      const capsuleReplyCode = await commentCode(capsuleReply);
      const capsuleReplyMarkdown = await readTarget(capsuleReplyCode, capsuleReplyMarker);
      assert(capsuleReplyMarkdown.includes(`Selected implementation target: Task ${taskTicketCode}.`),
        'A reply to a task capsule must retain that task capsule as its sole contract');
      assert(capsuleReplyMarkdown.includes(`Task capsule selected through grouped child ${marker}`));
      assert(!capsuleReplyMarkdown.includes(`Job capsule version one ${marker}`),
        'A task-capsule discussion must not inject the enclosing job capsule');
      const capsuleReplyThreadResponse = await retryMcp('get_job', {
        short_code_id: capsuleReplyCode,
        thread_only: true
      });
      const capsuleReplyThread = toolText(capsuleReplyThreadResponse);
      assert(capsuleReplyThread.includes(`Selected implementation target: Task ${taskTicketCode}.`));
      assert(capsuleReplyThread.includes(`Task capsule selected through grouped child ${marker}`)
        && capsuleReplyThread.includes(capsuleReplyMarker));
      assert(!capsuleReplyThread.includes(`Job capsule version one ${marker}`));
      assert.strictEqual(capsuleReplyThread.split(CAPSULE_HEADING).length - 1, 1,
        'A thread-only capsule discussion must render the selected capsule exactly once');

      const jobCapsuleNotifications = await pollFor(
        async () => ((await getMessages(adminConfiguration)) || []).filter((message) =>
          message.type_object_id === `UNREAD_COMMENT_${persistedJobV1.id}`),
        (messages) => messages.length === 1 && messages[0].inbox_only === true,
        20,
        3000
      );
      assert.strictEqual(jobCapsuleNotifications.length, 1,
        'An AI capsule write should create one dismissible assignee inbox row');
      assert.strictEqual(jobCapsuleNotifications[0].inbox_only, true);
      assert.strictEqual(jobCapsuleNotifications[0].level, 'YELLOW');
      assert.strictEqual(jobCapsuleNotifications[0].alert_type, 'AI_GENERATED');

      const blank = await retryMcp('set_design_capsule', {
        job_or_task_id: jobTicketCode,
        capsule: '   '
      });
      assertRefusal(blank, 'capsule must be nonblank');
      const xor = await retryMcp('set_design_capsule', {
        job_or_task_id: jobTicketCode,
        update_capsule_short_code_id: createdJob.capsule_short_code_id,
        update_capsule_version: 1,
        capsule: `Must not be saved ${marker}`
      });
      assertRefusal(xor, 'Choose exactly one mode');
      const duplicate = await retryMcp('set_design_capsule', {
        job_or_task_id: jobTicketCode,
        capsule: `Sequential duplicate ${marker}`
      });
      assertRefusal(duplicate, createdJob.capsule_short_code_id, 'version 1');

      const jobMarkdown = await readTarget(jobTicketCode, `Job capsule version one ${marker}`);
      assert(jobMarkdown.includes(`Selected implementation target: Job ${jobTicketCode}.`));
      assert(jobMarkdown.includes('Current capsule version: 1.'));
      assert(!jobMarkdown.includes(`Task capsule selected through grouped child ${marker}`),
        'Job get_job must not merge in a task capsule');
      const taskMarkdown = await readTarget(taskTicketCode,
        `Task capsule selected through grouped child ${marker}`);
      assert(taskMarkdown.includes(`Selected implementation target: Task ${taskTicketCode}.`));
      assert(!taskMarkdown.includes(`Job capsule version one ${marker}`),
        'Task get_job must not fall back to the job capsule');
      const groupedMarkdown = await readTarget(groupedTicketCode,
        `Task capsule selected through grouped child ${marker}`);
      assert(groupedMarkdown.includes(`Selected implementation target: Task ${taskTicketCode}.`),
        'Grouped get_job must select the normalized top-level task capsule');
      assert(!groupedMarkdown.includes(`Job capsule version one ${marker}`),
        'Grouped get_job must not merge in or fall back to the job capsule');

      const jobV2 = `## Outcome\nAI-revised capsule version two ${marker}.`;
      const updatedJob = structuredResult(await retryMcp('set_design_capsule', {
        update_capsule_short_code_id: createdJob.capsule_short_code_id,
        update_capsule_version: createdJob.capsule_version,
        capsule: jobV2
      }));
      assert.strictEqual(updatedJob.status, 'updated');
      assert.strictEqual(updatedJob.normalized_target, jobTicketCode);
      assert.strictEqual(updatedJob.capsule_short_code_id, createdJob.capsule_short_code_id,
        'A revision must keep the current R code stable');
      assert.strictEqual(updatedJob.capsule_version, 2);
      const unchanged = structuredResult(await retryMcp('set_design_capsule', {
        update_capsule_short_code_id: updatedJob.capsule_short_code_id,
        update_capsule_version: updatedJob.capsule_version,
        capsule: jobV2
      }));
      assert.strictEqual(unchanged.status, 'unchanged');
      assert.strictEqual(unchanged.capsule_version, 2,
        'An identical sanitized body must not increment the capsule version');

      const stale = await retryMcp('set_design_capsule', {
        update_capsule_short_code_id: createdJob.capsule_short_code_id,
        update_capsule_version: 1,
        capsule: `Stale overwrite ${marker}`
      });
      assertRefusal(stale, createdJob.capsule_short_code_id, 'version 2');

      comments = await waitForComments((items) =>
        items.some((comment) => comment.ticket_code === createdJob.capsule_short_code_id &&
          comment.version === 2) &&
        capsuleArchives(items, createdJob.capsule_short_code_id, 1).length === 1);
      let aiArchives = capsuleArchives(comments, createdJob.capsule_short_code_id, 1);
      assert.strictEqual(aiArchives.length, 1,
        'The AI body revision must eventually create exactly one version-one archive');
      assertArchive(aiArchives[0], persistedJobV1);
      assert.strictEqual(capsuleArchives(comments, createdJob.capsule_short_code_id, 2).length, 0,
        'The identical update must not create another archive');

      const currentJobCapsule = comments.find((comment) =>
        comment.ticket_code === createdJob.capsule_short_code_id && comment.pinned === true);
      assert(currentJobCapsule, 'The revised job capsule should remain the current pinned R');
      assert.strictEqual(currentJobCapsule.version, 2);
      const humanBody = `<h2>Outcome</h2><p>Human-revised capsule version three ${marker}.</p>`;
      const humanUpdated = await adminClient.investibles.updateComment(
        currentJobCapsule.id,
        humanBody,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        currentJobCapsule.version
      );
      assert.strictEqual(humanUpdated.id, currentJobCapsule.id);
      assert.strictEqual(humanUpdated.ticket_code, createdJob.capsule_short_code_id);
      assert.strictEqual(humanUpdated.version, 3);

      comments = await waitForComments((items) => {
        const current = items.find((comment) =>
          comment.ticket_code === createdJob.capsule_short_code_id && comment.version === 3);
        return current && capsuleArchives(items, createdJob.capsule_short_code_id, 2).length === 1;
      });
      const humanArchives = capsuleArchives(comments, createdJob.capsule_short_code_id, 2);
      assert.strictEqual(humanArchives.length, 1,
        'The human body revision must eventually create exactly one version-two archive');
      assertArchive(humanArchives[0], currentJobCapsule);
      aiArchives = capsuleArchives(comments, createdJob.capsule_short_code_id, 1);
      assert.strictEqual(aiArchives.length, 1,
        'Async retries must not duplicate the deterministic AI revision archive');
      const revisedMarkdown = await readTarget(jobTicketCode,
        `Human-revised capsule version three ${marker}`);
      assert(revisedMarkdown.includes('Current capsule version: 3.'),
        'get_job must expose the expected version needed for the next CAS update');
      assert(!revisedMarkdown.includes(`AI-revised capsule version two ${marker}`),
        'A prior body archived with Show AI off must not compete with the current capsule');

      const raceTaskMarker = `Race target task ${marker}`;
      const raceTask = await adminClient.investibles.createComment(
        job.investible.id, marketId, raceTaskMarker, null, 'TODO');
      const raceTaskCode = await commentCode(raceTask);
      const raceBodies = Array.from({ length: 12 }, (_, index) =>
        `## Outcome\nConcurrent candidate ${index} ${marker}.`);
      const raceResponses = await Promise.all(raceBodies.map((capsule) =>
        retryMcp('set_design_capsule', {
          job_or_task_id: raceTaskCode,
          capsule
        })));
      const createdRaceCapsules = [];
      let raceRefusalCount = 0;
      raceResponses.forEach((response, index) => {
        const result = toolResult(response);
        if (result.isError === true) {
          raceRefusalCount += 1;
          assert(toolText(response).includes('Current capsule is'),
            `A losing concurrent create should identify the current capsule: ${response}`);
          return;
        }
        const payload = structuredResult(response);
        assert.strictEqual(payload.status, 'created');
        assert.strictEqual(payload.normalized_target, raceTaskCode);
        createdRaceCapsules.push({ ...payload, body: raceBodies[index] });
      });
      assert(createdRaceCapsules.length >= 1,
        `The concurrent create race produced no capsule: ${JSON.stringify(raceResponses)}`);

      const createdRaceCodes = new Set(createdRaceCapsules
        .map((capsule) => capsule.capsule_short_code_id));
      comments = await waitForComments((items) =>
        [...createdRaceCodes].every((code) => items.some((comment) => comment.ticket_code === code)));
      const raceRows = comments.filter((comment) => createdRaceCodes.has(comment.ticket_code));
      const pinnedRaceRows = raceRows.filter((comment) => comment.pinned === true)
        .sort(capsuleOrder);
      assert(pinnedRaceRows.length >= 1,
        `The race must leave a selected current capsule: ${JSON.stringify(raceRows)}`);
      const selectedRaceRow = pinnedRaceRows[0];
      const selectedRace = createdRaceCapsules.find((capsule) =>
        capsule.capsule_short_code_id === selectedRaceRow.ticket_code);
      assert(selectedRace, `Selected race row did not match a successful create: ${selectedRaceRow.ticket_code}`);
      const selectedRaceMarker = selectedRace.body.split('\n')[1];
      const raceMarkdown = await readTarget(raceTaskCode, selectedRaceMarker);
      assert(raceMarkdown.includes(`Selected implementation target: Task ${raceTaskCode}.`));
      createdRaceCapsules
        .filter((capsule) => capsule.capsule_short_code_id !== selectedRace.capsule_short_code_id)
        .forEach((loser) => {
          assert(!raceMarkdown.includes(loser.body.split('\n')[1]),
            `get_job selected race loser ${loser.capsule_short_code_id}`);
        });

      const repaired = structuredResult(await retryMcp('set_design_capsule', {
        update_capsule_short_code_id: selectedRace.capsule_short_code_id,
        update_capsule_version: selectedRace.capsule_version,
        capsule: selectedRace.body
      }));
      assert.strictEqual(repaired.status, 'unchanged',
        'A repair-only write should not manufacture a body revision');
      comments = await waitForComments((items) => {
        const rows = items.filter((comment) => createdRaceCodes.has(comment.ticket_code));
        return rows.length === createdRaceCodes.size &&
          rows.filter((comment) => comment.pinned === true).length === 1;
      });
      const repairedRows = comments.filter((comment) => createdRaceCodes.has(comment.ticket_code));
      assert.strictEqual(repairedRows.length, createdRaceCodes.size,
        'Every successful concurrent create must remain durable through repair');
      const repairedCurrent = repairedRows.filter((comment) => comment.pinned === true);
      assert.strictEqual(repairedCurrent.length, 1,
        'The next capsule write must converge any race to one pinned current');
      assert.strictEqual(repairedCurrent[0].ticket_code, selectedRace.capsule_short_code_id);
      repairedRows
        .filter((comment) => comment.ticket_code !== selectedRace.capsule_short_code_id)
        .forEach((loser) => assert.strictEqual(loser.pinned, false,
          `Successful race loser ${loser.ticket_code} must become an ordinary unpinned note`));
      if (createdRaceCapsules.length === 1) {
        assert.strictEqual(raceRefusalCount, raceBodies.length - 1,
          'A serialized race must atomically refuse every create after its sole winner');
      } else {
        assert(repairedRows.some((comment) =>
          comment.ticket_code !== selectedRace.capsule_short_code_id && comment.pinned === false),
          'A race that creates temporary duplicates must repair at least one successful loser');
      }
    }).timeout(900000);

    it('keeps reviews as freeform, explicit, agent-owned delta handoffs naming the stable capsule R', async () => {
      const marker = randomUUID();
      const tools = await listMcpTools();
      const reviewTool = tools.find((tool) => tool.name === 'ask_for_review');
      assert(reviewTool, 'tools/list must retain ask_for_review');
      assert.deepStrictEqual(
        Object.keys(reviewTool.inputSchema.properties).sort(),
        ['job_id', 'report', 'update_review_short_code_id', 'uploaded_files'],
        'ask_for_review must remain the existing freeform report schema without capsule delta fields'
      );
      assert.strictEqual(reviewTool.inputSchema.properties.report.type, 'string',
        'Review delta content must remain freeform prose');
      assert.deepStrictEqual(reviewTool.inputSchema.oneOf.map((choice) => choice.required), [
        ['job_id', 'report'],
        ['update_review_short_code_id', 'report']
      ], 'ask_for_review must retain its existing create-or-update modes');

      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Capsule review lifecycle ${marker}`,
        description: 'Reviews describe a delta from the current capsule but remain ordinary reports.',
        assignments: [adminId]
      });
      const jobTicketCode = await jobCode(job);
      const capsuleV1 = `## Outcome\nReview baseline version one ${marker}.`;
      const createdCapsule = structuredResult(await retryMcp('set_design_capsule', {
        job_or_task_id: jobTicketCode,
        capsule: capsuleV1
      }));

      const deltaMarker = `Delta review ${marker}`;
      const deltaReport = `${deltaMarker}: review ${createdCapsule.capsule_short_code_id}; ` +
        'implementation delta: added target-scoped capsule selection and conflict-safe updates; ' +
        'verified the integration boundary.';
      const reviewResponse = await retryMcp('ask_for_review', {
        job_id: jobTicketCode,
        report: deltaReport
      });
      const reviewResult = toolResult(reviewResponse);
      assert.strictEqual(reviewResult.structuredContent, undefined,
        'ask_for_review must not acquire a structured capsule-delta response');
      assert(toolText(reviewResponse).includes('Added report with id'),
        `ask_for_review should create an ordinary report: ${reviewResponse}`);

      let comments = await waitForComments((items) =>
        items.some((comment) => comment.body?.includes(deltaMarker) && comment.ticket_code));
      const deltaReview = comments.find((comment) => comment.body?.includes(deltaMarker));
      assert(deltaReview.ticket_code?.startsWith('R-'));
      assert(deltaReview.body.includes(createdCapsule.capsule_short_code_id),
        'Review prose must name the stable current capsule R code');
      assert(deltaReview.created_by && deltaReview.created_by !== adminId,
        'The review under test must be owned by the workspace AI user');
      assert.notStrictEqual(deltaReview.resolved, true, 'A new delta review must be open');

      const capsuleV2 = `## Outcome\nReview baseline version two ${marker}.`;
      const revisedCapsule = structuredResult(await retryMcp('set_design_capsule', {
        update_capsule_short_code_id: createdCapsule.capsule_short_code_id,
        update_capsule_version: createdCapsule.capsule_version,
        capsule: capsuleV2
      }));
      assert.strictEqual(revisedCapsule.status, 'updated');
      assert.strictEqual(revisedCapsule.capsule_short_code_id,
        createdCapsule.capsule_short_code_id, 'Capsule revision must retain the R named by the review');
      const revisedJob = await readTarget(jobTicketCode, `Review baseline version two ${marker}`);
      assert(revisedJob.includes('Current capsule version: 2.'));
      // Wait through the capsule's async archive path before ruling out an implicit review close.
      comments = await waitForComments((items) =>
        items.some((comment) => comment.ticket_code === createdCapsule.capsule_short_code_id &&
          comment.version === 2) &&
        capsuleArchives(items, createdCapsule.capsule_short_code_id, 1).length === 1);
      assert.strictEqual(capsuleArchives(
        comments, createdCapsule.capsule_short_code_id, 1).length, 1,
        'The capsule archive stream must complete before checking the review lifecycle');
      assert(comments.some((comment) =>
        comment.ticket_code === createdCapsule.capsule_short_code_id && comment.version === 2),
        'The revised capsule must reach the human version stream before checking the review lifecycle');
      const stillOpenReview = comments.find((comment) => comment.id === deltaReview.id);
      assert(stillOpenReview, 'The open review must remain readable after capsule revision');
      assert.notStrictEqual(stillOpenReview.resolved, true,
        'Revising the capsule must not auto-resolve its open review');

      const resolved = await retryMcp('resolve', { short_code_id: deltaReview.ticket_code });
      assert(toolText(resolved).includes('Resolved'),
        `The agent must explicitly resolve its obsolete review: ${resolved}`);
      comments = await waitForComments((items) =>
        items.some((comment) => comment.id === deltaReview.id && comment.resolved === true));
      assert.strictEqual(comments.find((comment) => comment.id === deltaReview.id)?.resolved, true,
        'The agent-owned review should close only after explicit resolve');

      const noDeltaMarker = `No capsule delta ${marker}`;
      const noDeltaReport = `${noDeltaMarker}: ${revisedCapsule.capsule_short_code_id} remains current; ` +
        'No implementation deltas. The completed verification is ready for review.';
      const noDeltaResponse = await retryMcp('ask_for_review', {
        job_id: jobTicketCode,
        report: noDeltaReport
      });
      assert.strictEqual(toolResult(noDeltaResponse).structuredContent, undefined,
        'A no-delta handoff must remain freeform report prose');
      assert(toolText(noDeltaResponse).includes('Added report with id'));
      comments = await waitForComments((items) =>
        items.some((comment) => comment.body?.includes(noDeltaMarker) && comment.ticket_code));
      const noDeltaReview = comments.find((comment) => comment.body?.includes(noDeltaMarker));
      assert(noDeltaReview.body.includes(revisedCapsule.capsule_short_code_id));
      assert.notStrictEqual(noDeltaReview.resolved, true, 'The new no-delta review must be open');
      assert.notStrictEqual(noDeltaReview.id, deltaReview.id,
        'A resolved handoff must be followed by a new review, not a backend rewrite');
    }).timeout(600000);
  });
}
