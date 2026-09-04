import assert from 'assert';
import { randomUUID } from 'crypto';
import AWS from 'aws-sdk';
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
const REGION = 'us-west-2';
const COMMENTS_TABLE_BY_BASE_URL = new Map([
  ['https://dev.api.uclusion.com/v1', 'uclusion-markets-dev-comments'],
  ['https://stage.api.uclusion.com/v1', 'uclusion-markets-dev-comments']
]);

export default function (adminConfiguration) {
  describe('#test intent/design capsule MCP integration (J-Marketing-33)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let adminId;
    let documentClient;
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
      documentClient = new AWS.DynamoDB.DocumentClient({ region: REGION });
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

    async function setAssociatedRelocationBarrier(commentId, ownerId, enabled) {
      const tableName = COMMENTS_TABLE_BY_BASE_URL.get(adminConfiguration.baseURL);
      assert(tableName,
        `Relocation barrier is not allowed in ${adminConfiguration.baseURL}`);
      const response = await documentClient.update({
        TableName: tableName,
        Key: { id: commentId },
        UpdateExpression: 'SET #pinned = :enabled, #machine = :enabled ADD #version :one',
        ConditionExpression:
          '#market = :market AND #association = :owner AND #type = :report ' +
          'AND #pinned = :previousEnabled AND #machine = :previousEnabled ' +
          'AND #notification = :blue',
        ExpressionAttributeNames: {
          '#association': 'associated_comment_id',
          '#machine': 'is_machine_only',
          '#market': 'market_id',
          '#notification': 'notification_type',
          '#pinned': 'pinned',
          '#type': 'comment_type',
          '#version': 'version'
        },
        ExpressionAttributeValues: {
          ':enabled': enabled,
          ':blue': 'BLUE',
          ':market': marketId,
          ':one': 1,
          ':owner': ownerId,
          ':previousEnabled': !enabled,
          ':report': 'REPORT'
        },
        ReturnValues: 'ALL_NEW'
      }).promise();
      assert.strictEqual(response.Attributes?.pinned, enabled);
      assert.strictEqual(response.Attributes?.is_machine_only, enabled);
      assert.strictEqual(response.Attributes?.notification_type, 'BLUE');
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
      const signatures = [...commentVersions]
        .map(([id, version]) => ({ id, version }));
      const batches = [];
      for (let offset = 0; offset < signatures.length; offset += 100) {
        batches.push(signatures.slice(offset, offset + 100));
      }
      return (await Promise.all(batches.map((batch) =>
        adminClient.investibles.getMarketComments(batch)))).flat();
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

    function currentCapsuleSection(markdown) {
      const start = markdown.indexOf(CAPSULE_HEADING);
      if (start < 0) {
        return '';
      }
      const afterHeading = start + CAPSULE_HEADING.length;
      const boundary = markdown.slice(afterHeading)
        .search(/\n#### (?:Reports|Tasks|Assistance|Notes|Resolved)\b/);
      const end = boundary < 0 ? markdown.length : afterHeading + boundary;
      return markdown.slice(start, end);
    }

    async function readTarget(shortCode, expectedMarker, renderedStateIsReady = () => true) {
      const hasExpectedState = (markdown) =>
        markdown.includes(CAPSULE_HEADING) &&
        markdown.includes(expectedMarker) &&
        renderedStateIsReady(markdown);
      const response = await pollFor(
        () => retryMcp('get_job', { short_code_id: shortCode }),
        (candidate) => hasExpectedState(toolText(candidate)),
        20,
        3000
      );
      const markdown = toolText(response);
      assert(hasExpectedState(markdown),
        `get_job ${shortCode} did not reach the expected state containing ${expectedMarker}: ${markdown}`);
      return markdown;
    }

    async function addInfoCode(shortCode, body) {
      const response = await retryMcp('add_info', {
        short_code_id: shortCode,
        info: body,
        tz: 'America/Los_Angeles'
      });
      const match = toolText(response).match(/Added info with id (\S+) and link/);
      assert(match, `add_info did not return the created note R code: ${response}`);
      return match[1];
    }

    async function addInfo(shortCode, body) {
      const code = await addInfoCode(shortCode, body);
      const comments = await waitForComments((items) =>
        items.some((comment) => comment.ticket_code === code));
      return comments.find((comment) => comment.ticket_code === code);
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

    function allCapsuleArchives(comments, sourceCode) {
      const prefix = `Former intent/design capsule ${sourceCode}, version `;
      return comments.filter((comment) => comment.body?.includes(prefix));
    }

    function capsuleArchives(comments, sourceCode, sourceVersion) {
      const prefix = `Former intent/design capsule ${sourceCode}, version ${sourceVersion}.`;
      return allCapsuleArchives(comments, sourceCode)
        .filter((comment) => comment.body.includes(prefix));
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

    it('upserts target-scoped capsules, archives revisions, and converges an identical race', async () => {
      const marker = randomUUID();
      const tools = await listMcpTools();
      const capsuleTool = tools.find((tool) => tool.name === 'set_design_capsule');
      assert(capsuleTool?.description.includes('creates the capsule when absent or replaces'),
        'set_design_capsule copy must describe target-only create-or-replace behavior');
      assert.deepStrictEqual(
        Object.keys(capsuleTool.inputSchema.properties).sort(),
        ['capsule', 'job_id', 'task_id', 'update_capsule_short_code_id',
          'update_capsule_version'],
        'Target mode must state the job and optionally its task'
      );
      assert.deepStrictEqual(
        capsuleTool.inputSchema.oneOf.map((choice) => choice.required),
        [['job_id'], ['update_capsule_short_code_id', 'update_capsule_version']],
        'A task-only target must not satisfy either capsule write mode'
      );
      assert.deepStrictEqual(
        capsuleTool.inputSchema.oneOf[0].not.anyOf
          .map((rule) => rule.required[0]).sort(),
        ['update_capsule_short_code_id', 'update_capsule_version'],
        'Target mode must exclude explicit R/version fields'
      );
      assert.deepStrictEqual(
        capsuleTool.inputSchema.oneOf[1].not.anyOf
          .map((rule) => rule.required[0]).sort(),
        ['job_id', 'task_id'],
        'Explicit R/version mode must exclude target fields'
      );
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
        job_id: jobTicketCode,
        capsule: jobV1
      }));
      assert.strictEqual(createdJob.status, 'created');
      assert.strictEqual(createdJob.normalized_target, jobTicketCode);
      assert(createdJob.capsule_short_code_id.startsWith('R-'));
      assert.strictEqual(createdJob.capsule_version, 1);
      assert(createdJob.link.includes(createdJob.capsule_short_code_id));

      const createdTask = structuredResult(await retryMcp('set_design_capsule', {
        job_id: jobTicketCode,
        task_id: groupedTicketCode,
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
      assert.strictEqual(capsuleReplyThread
        .split(`Task capsule selected through grouped child ${marker}`).length - 1, 1,
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
        job_id: jobTicketCode,
        capsule: '   '
      });
      assertRefusal(blank, 'capsule must be nonblank');
      const xor = await retryMcp('set_design_capsule', {
        job_id: jobTicketCode,
        update_capsule_short_code_id: createdJob.capsule_short_code_id,
        update_capsule_version: 1,
        capsule: `Must not be saved ${marker}`
      });
      assertRefusal(xor, 'Choose exactly one mode');
      const removedTargetField = await retryMcp('set_design_capsule', {
        job_id: jobTicketCode,
        job_or_task_id: taskTicketCode,
        capsule: `Must not ignore a removed target field ${marker}`
      });
      assertRefusal(removedTargetField, 'Unknown set_design_capsule fields', 'job_or_task_id');

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
        job_id: jobTicketCode,
        capsule: jobV2
      }));
      assert.strictEqual(updatedJob.status, 'updated');
      assert.strictEqual(updatedJob.normalized_target, jobTicketCode);
      assert.strictEqual(updatedJob.capsule_short_code_id, createdJob.capsule_short_code_id,
        'A target-only replacement must keep the current R code stable');
      assert.strictEqual(updatedJob.capsule_version, 2);
      const unchanged = structuredResult(await retryMcp('set_design_capsule', {
        job_id: jobTicketCode,
        capsule: jobV2
      }));
      assert.strictEqual(unchanged.status, 'unchanged');
      assert.strictEqual(unchanged.capsule_short_code_id, createdJob.capsule_short_code_id);
      assert.strictEqual(unchanged.capsule_version, 2,
        'An identical target-only body must not increment the capsule version');

      const explicitUnchanged = structuredResult(await retryMcp('set_design_capsule', {
        update_capsule_short_code_id: unchanged.capsule_short_code_id,
        update_capsule_version: unchanged.capsule_version,
        capsule: jobV2
      }));
      assert.strictEqual(explicitUnchanged.status, 'unchanged');
      assert.strictEqual(explicitUnchanged.capsule_short_code_id, createdJob.capsule_short_code_id,
        'An explicit current-version write must retain the same capsule R code');
      assert.strictEqual(explicitUnchanged.capsule_version, 2);

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
      const raceBody = `## Outcome\nConcurrent identical candidate ${marker}.`;
      const raceResponses = await Promise.all(Array.from({ length: 12 }, () =>
        retryMcp('set_design_capsule', {
          job_id: jobTicketCode,
          task_id: raceTaskCode,
          capsule: raceBody
        })));
      const successfulRaceCapsules = [];
      const raceConflictTexts = [];
      raceResponses.forEach((response) => {
        const result = toolResult(response);
        if (result.isError === true) {
          const text = toolText(response);
          assert(text.includes('set_design_capsule was refused:')
            && text.includes('Current capsule is R-')
            && text.includes('at version'),
            `A bounded race refusal must identify the current R and version: ${response}`);
          raceConflictTexts.push(text);
          return;
        }
        const payload = structuredResult(response);
        assert(['created', 'unchanged'].includes(payload.status),
          `An identical concurrent upsert cannot change the body: ${response}`);
        assert.strictEqual(payload.normalized_target, raceTaskCode);
        successfulRaceCapsules.push(payload);
      });
      assert(successfulRaceCapsules.some((capsule) => capsule.status === 'created'),
        `The concurrent upsert race produced no capsule: ${JSON.stringify(raceResponses)}`);
      assert.strictEqual(successfulRaceCapsules.filter(
        (capsule) => capsule.status === 'created').length, 1,
        'Exactly one concurrent upsert may create the stable capsule row');

      const createdRaceCodes = new Set(successfulRaceCapsules
        .map((capsule) => capsule.capsule_short_code_id));
      assert.strictEqual(createdRaceCodes.size, 1,
        'Every successful identical upsert must return the same stable R code');
      const stableRaceCode = [...createdRaceCodes][0];
      raceConflictTexts.forEach((text) => assert(text.includes(stableRaceCode),
        `Every race refusal must identify the stable current R: ${text}`));
      comments = await waitForComments((items) =>
        items.some((comment) => comment.ticket_code === stableRaceCode));
      const raceRows = comments.filter((comment) =>
        comment.associated_comment_id === raceTask.id &&
        comment.comment_type === 'REPORT' && comment.notification_type === 'BLUE');
      assert.strictEqual(raceRows.length, 1,
        `Identical concurrent upserts must persist one capsule row: ${JSON.stringify(raceRows)}`);
      assert.strictEqual(raceRows[0].pinned, true);
      const selectedRaceMarker = raceBody.split('\n')[1];
      const raceMarkdown = await readTarget(raceTaskCode, selectedRaceMarker);
      assert(raceMarkdown.includes(`Selected implementation target: Task ${raceTaskCode}.`));
    }).timeout(900000);

    it('moves task-owned notes and capsule history to the task destination', async () => {
      const marker = randomUUID();
      const sourceJob = await adminClient.investibles.create({
        groupId: marketId,
        name: `Capsule move source ${marker}`,
        description: 'Owns the task and controls that must stay in the source job.',
        assignments: [adminId]
      });
      const destinationGroup = (await adminClient.markets.createGroup({
        name: `Capsule move destination group ${marker}`,
        ticket_sub_code: `move-${marker.slice(0, 8)}`
      })).group;
      const destinationJob = await adminClient.investibles.create({
        groupId: destinationGroup.id,
        name: `Capsule move destination ${marker}`,
        description: 'Receives the task and every note owned by it.',
        assignments: [adminId]
      });
      const sourceJobCode = await jobCode(sourceJob);
      const destinationJobCode = await jobCode(destinationJob);

      const sourceJobCapsuleBody = `## Outcome\nSource job control capsule ${marker}.`;
      const sourceJobCapsule = structuredResult(await retryMcp('set_design_capsule', {
        job_id: sourceJobCode,
        capsule: sourceJobCapsuleBody
      }));
      const sourceJobNote = await addInfo(sourceJobCode, `Source job control note ${marker}`);

      const task = await adminClient.investibles.createComment(
        sourceJob.investible.id, marketId, `Task to move ${marker}`, null, 'TODO');
      const taskCode = await commentCode(task);
      const groupedTask = await adminClient.investibles.createComment(
        sourceJob.investible.id, marketId, `Grouped task to move ${marker}`, task.id);
      const groupedTaskCode = await commentCode(groupedTask);
      assert(groupedTaskCode.startsWith('C-'));

      const taskNote = await addInfo(taskCode, `Top-level task note ${marker}`);
      const groupedTaskNote = await addInfo(groupedTaskCode, `Grouped task note ${marker}`);
      assert(taskNote.ticket_code.startsWith('R-') && groupedTaskNote.ticket_code.startsWith('R-'));
      assert.strictEqual(taskNote.associated_comment_id, task.id);
      assert.strictEqual(groupedTaskNote.associated_comment_id, groupedTask.id,
        'A grouped-task note must retain the exact grouped C owner');
      const batchedTaskNoteCodes = [];
      for (let index = 0; index < 100; index += 1) {
        batchedTaskNoteCodes.push(await addInfoCode(
          groupedTaskCode,
          `Task root batch note ${index} ${marker}`
        ));
      }
      const batchedTaskNoteCodeSet = new Set(batchedTaskNoteCodes);
      const batchedTaskNotes = (await waitForComments((items) =>
        batchedTaskNoteCodes.every((code) =>
          items.some((comment) => comment.ticket_code === code))))
        .filter((comment) => batchedTaskNoteCodeSet.has(comment.ticket_code));
      assert.strictEqual(batchedTaskNotes.length, 100,
        'The owner move fixture must cross the 100-root relocation batch boundary');

      const taskCapsuleV1Body = `## Outcome\nMovable task capsule version one ${marker}.`;
      const createdTaskCapsule = structuredResult(await retryMcp('set_design_capsule', {
        job_id: sourceJobCode,
        task_id: taskCode,
        capsule: taskCapsuleV1Body
      }));
      let comments = await waitForComments((items) =>
        items.some((comment) =>
          comment.ticket_code === createdTaskCapsule.capsule_short_code_id && comment.version === 1));
      const taskCapsuleV1 = comments.find((comment) =>
        comment.ticket_code === createdTaskCapsule.capsule_short_code_id);
      const taskCapsuleV2Body = `## Outcome\nMovable task capsule version two ${marker}.`;
      const revisedTaskCapsule = structuredResult(await retryMcp('set_design_capsule', {
        job_id: sourceJobCode,
        task_id: taskCode,
        capsule: taskCapsuleV2Body
      }));
      assert.strictEqual(revisedTaskCapsule.status, 'updated');
      assert.strictEqual(revisedTaskCapsule.capsule_short_code_id,
        createdTaskCapsule.capsule_short_code_id);

      comments = await waitForComments((items) =>
        items.some((comment) =>
          comment.ticket_code === revisedTaskCapsule.capsule_short_code_id &&
          comment.version === revisedTaskCapsule.capsule_version) &&
        capsuleArchives(items, revisedTaskCapsule.capsule_short_code_id, 1).length === 1);
      const currentTaskCapsule = comments.find((comment) =>
        comment.ticket_code === revisedTaskCapsule.capsule_short_code_id && comment.pinned === true);
      const taskCapsuleArchive = capsuleArchives(
        comments, revisedTaskCapsule.capsule_short_code_id, 1)[0];
      assertCurrentCapsule(currentTaskCapsule, task.id);
      assertArchive(taskCapsuleArchive, taskCapsuleV1);

      const associatedRoots = [
        taskNote,
        groupedTaskNote,
        currentTaskCapsule,
        taskCapsuleArchive,
        ...batchedTaskNotes
      ];
      const replyRoots = [
        taskNote,
        groupedTaskNote,
        currentTaskCapsule,
        taskCapsuleArchive,
        batchedTaskNotes[0]
      ];
      const associatedReplies = [];
      for (const [index, root] of replyRoots.entries()) {
        associatedReplies.push(await adminClient.investibles.createComment(
          sourceJob.investible.id,
          marketId,
          `Associated note reply ${index} ${marker}`,
          root.id,
          null,
          null,
          null,
          'RED'
        ));
      }
      associatedReplies.push(await adminClient.investibles.createComment(
        sourceJob.investible.id,
        marketId,
        `Nested associated note reply ${marker}`,
        associatedReplies[0].id,
        null,
        null,
        null,
        'RED'
      ));
      const trackedIds = [
        task.id,
        groupedTask.id,
        ...associatedRoots.map((comment) => comment.id),
        ...associatedReplies.map((comment) => comment.id),
        sourceJobNote.id
      ];
      comments = await waitForComments((items) =>
        trackedIds.every((id) => items.some((comment) => comment.id === id)) &&
        items.some((comment) => comment.ticket_code === sourceJobCapsule.capsule_short_code_id));
      const beforeMoveById = new Map(comments.map((comment) => [comment.id, comment]));
      associatedReplies.forEach((reply) => assert.strictEqual(
        beforeMoveById.get(reply.id).notification_type,
        'RED',
        'The reply fan-out must exercise preservation of non-default flags'
      ));
      const sourceJobCapsuleRow = comments.find((comment) =>
        comment.ticket_code === sourceJobCapsule.capsule_short_code_id);
      assertCurrentCapsule(sourceJobCapsuleRow);
      const preMoveCurrentTaskCapsule = beforeMoveById.get(currentTaskCapsule.id);

      const mismatchedJob404 = await retryMcp('set_design_capsule', {
        job_id: destinationJobCode,
        task_id: taskCode,
        capsule: `Must not be saved for a mismatched job ${marker}`
      });
      assertRefusal(mismatchedJob404, destinationJobCode, taskCode, 'does not exist');

      await assert.rejects(
        () => adminClient.investibles.moveComments(
          destinationJob.investible.id,
          [associatedReplies[0].id]
        ),
        'A public caller must not move a task-associated reply independently'
      );
      const destinationCapsuleV1Body =
        `## Outcome\nFresh destination task capsule version one ${marker}.`;
      let createdDestinationCapsule;
      await setAssociatedRelocationBarrier(taskNote.id, task.id, true);
      try {
        await adminClient.investibles.moveComments(destinationJob.investible.id, [task.id]);
        createdDestinationCapsule = structuredResult(await retryMcp('set_design_capsule', {
          job_id: destinationJobCode,
          task_id: taskCode,
          capsule: destinationCapsuleV1Body
        }));
      } finally {
        await setAssociatedRelocationBarrier(taskNote.id, task.id, false);
      }
      assert.strictEqual(createdDestinationCapsule.status, 'created');
      assert.strictEqual(createdDestinationCapsule.normalized_target, taskCode);
      assert.strictEqual(createdDestinationCapsule.capsule_version, 1);
      assert(createdDestinationCapsule.capsule_short_code_id.startsWith('R-'));
      assert.notStrictEqual(createdDestinationCapsule.capsule_short_code_id,
        revisedTaskCapsule.capsule_short_code_id,
        'A destination-scoped upsert must create a different R while the source R is absent');

      const movedIds = trackedIds.filter((id) => id !== sourceJobNote.id);
      comments = await waitForComments((items) => {
        const byId = new Map(items.map((comment) => [comment.id, comment]));
        return movedIds.every((id) =>
          byId.get(id)?.investible_id === destinationJob.investible.id) &&
          byId.get(currentTaskCapsule.id)?.pinned === false &&
          byId.get(currentTaskCapsule.id)?.body === preMoveCurrentTaskCapsule.body &&
          items.some((comment) =>
            comment.ticket_code === createdDestinationCapsule.capsule_short_code_id &&
            comment.pinned === true &&
            comment.body.includes(`Fresh destination task capsule version one ${marker}`)) &&
          allCapsuleArchives(items, revisedTaskCapsule.capsule_short_code_id).length === 1 &&
          byId.get(sourceJobNote.id)?.investible_id === sourceJob.investible.id &&
          items.find((comment) =>
            comment.ticket_code === sourceJobCapsule.capsule_short_code_id)?.investible_id ===
              sourceJob.investible.id;
      });
      const afterMoveById = new Map(comments.map((comment) => [comment.id, comment]));

      const stableFields = [
        'id', 'ticket_code', 'body', 'associated_comment_id', 'comment_type',
        'notification_type', 'pinned', 'resolved', 'deleted', 'is_visible',
        'is_machine_only', 'is_sent', 'created_by', 'uploaded_files', 'reply_id',
        'root_comment_id'
      ];
      movedIds.forEach((id) => {
        const before = beforeMoveById.get(id);
        const after = afterMoveById.get(id);
        assert(before && after, `Moved comment ${id} must remain readable`);
        assert.strictEqual(after.investible_id, destinationJob.investible.id);
        assert.strictEqual(after.group_id, destinationGroup.id);
        const fieldsToPreserve = id === currentTaskCapsule.id
          ? stableFields.filter((field) => field !== 'pinned')
          : stableFields;
        fieldsToPreserve.forEach((field) => assert.deepStrictEqual(
          after[field], before[field], `${field} changed while moving ${before.ticket_code || id}`));
      });
      assert.strictEqual(afterMoveById.get(currentTaskCapsule.id).pinned, false,
        'The older source capsule must converge as unpinned destination history');
      assert.strictEqual(afterMoveById.get(sourceJobNote.id).investible_id, sourceJob.investible.id);
      assert.strictEqual(afterMoveById.get(sourceJobNote.id).group_id, marketId);
      assert.strictEqual(comments.find((comment) =>
        comment.ticket_code === sourceJobCapsule.capsule_short_code_id).investible_id,
        sourceJob.investible.id);
      assert.strictEqual(comments.find((comment) =>
        comment.ticket_code === sourceJobCapsule.capsule_short_code_id).group_id, marketId);
      assert.strictEqual(allCapsuleArchives(
        comments, revisedTaskCapsule.capsule_short_code_id).length, 1,
        'Demoting the older source capsule must not add another archive');
      const destinationCurrentBeforeUpdate = comments.find((comment) =>
        comment.ticket_code === createdDestinationCapsule.capsule_short_code_id &&
        comment.pinned === true);
      assertCurrentCapsule(destinationCurrentBeforeUpdate, task.id);
      assert.strictEqual(destinationCurrentBeforeUpdate.investible_id,
        destinationJob.investible.id);
      assert.strictEqual(destinationCurrentBeforeUpdate.group_id, destinationGroup.id);
      assert.strictEqual(allCapsuleArchives(
        comments, createdDestinationCapsule.capsule_short_code_id).length, 0,
        'Creating the destination capsule must not create history');

      const freshDestinationMarker = `Fresh destination task capsule version one ${marker}`;
      const movedTaskCapsuleMarker = `Movable task capsule version two ${marker}`;
      const movedCapsuleIsHistory = (markdown) => {
        const currentCapsule = currentCapsuleSection(markdown);
        return currentCapsule.includes(freshDestinationMarker) &&
          markdown.includes(movedTaskCapsuleMarker) &&
          !currentCapsule.includes(movedTaskCapsuleMarker);
      };
      const taskMarkdown = await readTarget(
        taskCode, freshDestinationMarker, movedCapsuleIsHistory);
      const groupedMarkdown = await readTarget(
        groupedTaskCode, freshDestinationMarker, movedCapsuleIsHistory);
      assert(taskMarkdown.includes(`Selected implementation target: Task ${taskCode}.`));
      assert(groupedMarkdown.includes(`Selected implementation target: Task ${taskCode}.`));
      [taskMarkdown, groupedMarkdown].forEach((markdown) => {
        assert(!markdown.includes(`Source job control capsule ${marker}`));
        assert(markdown.includes(movedTaskCapsuleMarker),
          'The demoted source capsule must remain visible as destination history');
        assert(!currentCapsuleSection(markdown)
          .includes(movedTaskCapsuleMarker),
          'The demoted source capsule must not compete with the destination current capsule');
      });
      const destinationCapsuleV2Body =
        `## Outcome\nFresh destination task capsule version two ${marker}.`;
      const updatedDestinationCapsule = structuredResult(await retryMcp('set_design_capsule', {
        job_id: destinationJobCode,
        task_id: groupedTaskCode,
        capsule: destinationCapsuleV2Body
      }));
      assert.strictEqual(updatedDestinationCapsule.status, 'updated');
      assert.strictEqual(updatedDestinationCapsule.normalized_target, taskCode);
      assert.strictEqual(updatedDestinationCapsule.capsule_short_code_id,
        createdDestinationCapsule.capsule_short_code_id,
        'A later destination update must retain the new destination R');

      comments = await waitForComments((items) =>
        items.some((comment) =>
          comment.ticket_code === updatedDestinationCapsule.capsule_short_code_id &&
          comment.pinned === true &&
          comment.body.includes(`Fresh destination task capsule version two ${marker}`)) &&
        capsuleArchives(
          items,
          updatedDestinationCapsule.capsule_short_code_id,
          destinationCurrentBeforeUpdate.version
        ).length === 1 &&
        items.some((comment) =>
          comment.id === currentTaskCapsule.id && comment.pinned === false) &&
        allCapsuleArchives(items, revisedTaskCapsule.capsule_short_code_id).length === 1);
      const updatedDestinationCurrent = comments.find((comment) =>
        comment.ticket_code === updatedDestinationCapsule.capsule_short_code_id &&
        comment.pinned === true);
      assertCurrentCapsule(updatedDestinationCurrent, task.id);
      assert.strictEqual(updatedDestinationCurrent.investible_id,
        destinationJob.investible.id);
      assert.strictEqual(updatedDestinationCurrent.group_id, destinationGroup.id);
      const destinationArchives = capsuleArchives(
        comments,
        updatedDestinationCapsule.capsule_short_code_id,
        destinationCurrentBeforeUpdate.version
      );
      assert.strictEqual(destinationArchives.length, 1,
        'The later destination body update must create exactly one archive');
      assertArchive(destinationArchives[0], destinationCurrentBeforeUpdate);
      assert.strictEqual(allCapsuleArchives(
        comments, updatedDestinationCapsule.capsule_short_code_id).length, 1);
      assert.strictEqual(comments.find((comment) =>
        comment.id === currentTaskCapsule.id).pinned, false,
        'Updating the destination capsule must not repin the older source R');

      const updatedTaskMarkdown = await readTarget(
        taskCode, `Fresh destination task capsule version two ${marker}`);
      const updatedGroupedMarkdown = await readTarget(
        groupedTaskCode, `Fresh destination task capsule version two ${marker}`);
      assert(updatedTaskMarkdown.includes(`Selected implementation target: Task ${taskCode}.`));
      assert(updatedGroupedMarkdown.includes(`Selected implementation target: Task ${taskCode}.`));
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
        job_id: jobTicketCode,
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
      const deltaReviewMarkdown = await readTarget(jobTicketCode, deltaMarker);
      assert(deltaReviewMarkdown.includes(`](#${createdCapsule.capsule_short_code_id})`),
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
      const noDeltaReviewMarkdown = await readTarget(jobTicketCode, noDeltaMarker);
      assert(noDeltaReviewMarkdown.includes(`](#${revisedCapsule.capsule_short_code_id})`));
      assert.notStrictEqual(noDeltaReview.resolved, true, 'The new no-delta review must be open');
      assert.notStrictEqual(noDeltaReview.id, deltaReview.id,
        'A resolved handoff must be followed by a new review, not a backend rewrite');
    }).timeout(600000);
  });
}
