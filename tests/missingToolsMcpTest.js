import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

// J-all-358: agent-window tools - add_task/add_bug run as the human, add_job accepts an AI
// task list, and get_job supports scoped retrieval (sections, thread_only).
export default function (adminConfiguration) {
  describe('#test missing tools (J-all-358)', () => {
    let accountClient;
    let adminClient;
    let marketId;
    let uclusionToken;
    let accountToken;
    let adminId;

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
        name: 'Missing tools MCP integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      const adminUser = await adminClient.users.get();
      adminId = adminUser.id;
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
          await sleep(3000);
        }
      }
      return mcpCall(adminConfiguration, uclusionToken, toolName, args);
    }

    function extractShortCode(responseText) {
      const match = responseText.match(/with id ([A-Z]-[^ ]+) and link/);
      assert(match, `No short code in response: ${responseText}`);
      return match[1];
    }

    async function listMarketComments() {
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

    async function findCommentByMarker(marker) {
      const comments = await pollFor(
        () => listMarketComments(),
        (fetched) => fetched.some((comment) => comment.body?.includes(marker)));
      return comments.find((comment) => comment.body?.includes(marker));
    }

    async function getFullInvestible(investibleId) {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === marketId);
      const signatures = marketEntry?.signatures || [];
      const investibleVersion = Math.max(0, ...signatures
        .filter((signature) => signature.type === 'investible')
        .flatMap((signature) => signature.object_versions || [])
        .filter((version) => version.object_id_one === investibleId)
        .map((version) => version.version));
      const marketInfoVersions = new Map();
      signatures
        .filter((signature) => signature.type === 'market_investible')
        .flatMap((signature) => signature.object_versions || [])
        .filter((version) => version.object_id_two === investibleId)
        .forEach((version) => {
          const current = marketInfoVersions.get(version.object_id_one) || 0;
          marketInfoVersions.set(version.object_id_one, Math.max(current, version.version));
        });
      if (!investibleVersion || marketInfoVersions.size === 0) {
        return undefined;
      }
      const fetched = await adminClient.markets.getMarketInvestibles([{
        investible: { id: investibleId, version: investibleVersion },
        market_infos: [...marketInfoVersions]
          .map(([id, version]) => ({ id, version }))
      }]);
      return fetched?.[0];
    }

    it('creates a job with an AI task list and supports scoped get_job', async () => {
      const descriptionMarker = `Description ${randomUUID()}`;
      const taskMarkerA = `First piece ${randomUUID()}`;
      const taskMarkerB = `Second piece ${randomUUID()}`;
      const created = await pollMcp('add_job', {
        name: 'Missing tools scoping job',
        description: descriptionMarker,
        tasks: [taskMarkerA, taskMarkerB]
      });
      assert(created.includes('Created 2 tasks'), `add_job should report its task list: ${created}`);
      const jobCode = extractShortCode(created);
      const questionMarker = `Which direction ${randomUUID()}?`;
      await pollMcp('ask_question', { job_id: jobCode, question: questionMarker });
      const fullMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: jobCode }),
        (markdown) => typeof markdown === 'string' && markdown.includes(taskMarkerA) &&
          markdown.includes(taskMarkerB) && markdown.includes(questionMarker));
      assert(fullMarkdown.includes(taskMarkerA) && fullMarkdown.includes(taskMarkerB),
        'AI task list should land as real tasks on create');

      const tasksOnly = await pollMcp('get_job', { short_code_id: jobCode, sections: ['tasks'] });
      assert(tasksOnly.includes(taskMarkerA), 'sections tasks should include the tasks');
      assert(!tasksOnly.includes(questionMarker), 'sections tasks should exclude assistance');
      assert(tasksOnly.includes(descriptionMarker), 'scoped get_job keeps the job description');

      const assistanceOnly = await pollMcp('get_job', { short_code_id: jobCode, sections: ['assistance'] });
      assert(assistanceOnly.includes(questionMarker), 'sections assistance should include the question');
      assert(!assistanceOnly.includes(taskMarkerA), 'sections assistance should exclude tasks');
    }).timeout(240000);

    it('adds a task as the human and fetches just its thread', async () => {
      const jobDescription = `Thread job ${randomUUID()}`;
      const created = await pollMcp('add_job', { name: 'Missing tools thread job',
        description: jobDescription });
      const jobCode = extractShortCode(created);
      const taskMarker = `Human directed task ${randomUUID()}`;
      const taskResponse = await pollMcp('add_task', { job_id: jobCode, task: taskMarker });
      const taskCode = extractShortCode(taskResponse);
      assert(taskCode.startsWith('T-'), `add_task should mint a task code: ${taskCode}`);

      const threadMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: taskCode, thread_only: true }),
        (markdown) => typeof markdown === 'string' && markdown.includes(taskMarker));
      assert(threadMarkdown.includes(taskMarker), 'thread_only should include the task body');
      assert(!threadMarkdown.includes(jobDescription),
        'thread_only should not render the enclosing job');
      // Created as the human, so no AI attribution
      assert(!threadMarkdown.includes('From AI user'),
        'add_task must create the task as the human token owner');
    }).timeout(240000);

    it('adds a blocker as the human that takes the job out of doable flow', async () => {
      const created = await pollMcp('add_job', { name: 'Missing tools blocker job',
        description: `Blocker job ${randomUUID()}` });
      const jobCode = extractShortCode(created);
      const blockerMarker = `Blocked until dependency ships ${randomUUID()}`;
      const response = await pollMcp('add_blocker', { job_id: jobCode, blocker: blockerMarker });
      const blockerCode = extractShortCode(response);
      const jobMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: jobCode }),
        (markdown) => typeof markdown === 'string' && markdown.includes(blockerMarker));
      assert(jobMarkdown.includes(blockerMarker), `Blocker ${blockerCode} should render on the job`);
      assert(!jobMarkdown.includes('From AI user'),
        'add_blocker must create the blocker as the human token owner');
    }).timeout(240000);

    it('uploads via presigned post and attaches the file to info', async () => {
      const created = await pollMcp('add_job', { name: 'Missing tools upload job',
        description: `Upload job ${randomUUID()}` });
      const jobCode = extractShortCode(created);
      const fileContent = `Attached evidence file ${randomUUID()}`;
      const contentLength = Buffer.byteLength(fileContent);
      const uploadResponse = await pollMcp('get_upload',
        { content_type: 'text/plain', content_length: contentLength, original_name: 'evidence.txt' });
      // mcpCall returns the whole JSON-RPC envelope as a string - the tool payload is the text content
      const envelope = JSON.parse(uploadResponse);
      const upload = JSON.parse(envelope.result.content[0].text);
      // Dev's UI origin (localhost) has no .uclusion.com to swap for the CDN host, so the
      // imagecdn form and the authorization src-rewrite only exist on deployed environments
      const expectCdn = !adminConfiguration.baseURL.includes('//dev.');
      assert(upload.file_url?.endsWith(upload.metadata.path),
        `get_upload file_url should reference the upload path: ${uploadResponse}`);
      if (expectCdn) {
        assert(upload.file_url.includes('imagecdn.uclusion.com'),
          `get_upload should return an imagecdn file_url: ${uploadResponse}`);
      }
      // The agent does the multipart S3 POST itself - fields first, file last (Q-all-394 O-4)
      const boundary = `----uclusion${randomUUID()}`;
      let body = '';
      for (const [key, value] of Object.entries(upload.presigned_post.fields)) {
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
      }
      body += `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\n` +
        `Content-Type: text/plain\r\n\r\n${fileContent}\r\n--${boundary}--\r\n`;
      const s3Response = await fetch(upload.presigned_post.url, { method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
      assert(s3Response.status < 300, `S3 upload should succeed: ${s3Response.status}`);
      await pollMcp('add_info', { short_code_id: jobCode,
        info: `Evidence attached ![evidence](${upload.file_url})`,
        uploaded_files: [upload.metadata], tz: 'America/New_York' });
      // The server may re-home the upload under the market prefix, so match the file name part
      const fileName = upload.metadata.path.split('/')[1];
      const jobMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: jobCode }),
        (markdown) => typeof markdown === 'string' && markdown.includes(fileName));
      assert(jobMarkdown.includes(fileName),
        'get_job should render the attached file reference');
      if (expectCdn) {
        assert(jobMarkdown.includes('authorization='),
          'get_job should authorize the attached image URL');
      }
    }).timeout(240000);

    it('requests work and notifies the workspace humans', async () => {
      const response = await pollMcp('request_work', {});
      assert(response.includes('Requested work'), `request_work should confirm: ${response}`);
      const requestMessage = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) => message.type_object_id === `REQUEST_WORK_${marketId}`);
      }, (message) => message);
      assert(requestMessage, 'request_work should notify the human with a REQUEST_WORK row');
      assert(requestMessage.level === 'YELLOW', 'request_work notification should be YELLOW');
    }).timeout(240000);

    it('adds a view level bug as the human with a severity', async () => {
      const bugMarker = `Reported bug ${randomUUID()}`;
      const response = await pollMcp('add_bug', { bug: bugMarker, severity: 'YELLOW' });
      const bugCode = extractShortCode(response);
      assert(bugCode.startsWith('B-'), `add_bug should mint a bug code: ${bugCode}`);
      const bugMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: bugCode }),
        (markdown) => typeof markdown === 'string' && markdown.includes(bugMarker));
      assert(bugMarkdown.includes(bugMarker), 'get_job should render the created bug');
      assert(!bugMarkdown.includes('From AI user'),
        'add_bug must create the bug as the human token owner');
    }).timeout(240000);

    it('converts an option-bearing bug into a human-owned Bugs job and asks there', async () => {
      const marker = randomUUID();
      const bugMarker = `Bug converted with its thread ${marker}`;
      const addedBug = await pollMcp('add_bug', { bug: bugMarker, severity: 'YELLOW' });
      const bugCode = extractShortCode(addedBug);
      const originalBug = await findCommentByMarker(bugMarker);
      assert(originalBug && !originalBug.investible_id,
        'The source bug should begin as a view-level comment');
      const replyMarker = `Existing bug reply moves too ${marker}`;
      const originalReply = await adminClient.investibles.createComment(
        undefined, marketId, replyMarker, originalBug.id);

      const questionMarker = `Which fix should this bug use ${marker}?`;
      const optionOne = `Focused fix ${marker}`;
      const optionTwo = `Broader fix ${marker}`;
      const converted = await pollMcp('ask_question', {
        job_id: bugCode,
        question: questionMarker,
        options: [
          { name: optionOne, description: 'Change only the directly reported behavior.' },
          { name: optionTwo, description: 'Apply the same rule to adjacent behavior too.' }
        ]
      });
      const jobCodes = [...new Set(converted.match(/\bJ-[A-Za-z0-9-]+\b/g) || [])];
      const questionCodes = [...new Set(converted.match(/\bQ-[A-Za-z0-9-]+\b/g) || [])];
      assert.strictEqual(jobCodes.length, 1,
        `Bug conversion should return one job code and link: ${converted}`);
      assert.strictEqual(questionCodes.length, 1,
        `Bug conversion should return one question code and link: ${converted}`);
      const [jobCode] = jobCodes;
      const [questionCode] = questionCodes;

      const jobMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: jobCode }),
        (markdown) => markdown.includes(bugMarker) && markdown.includes(replyMarker) &&
          markdown.includes(questionMarker) && markdown.includes(optionOne) &&
          markdown.includes(optionTwo) && markdown.includes('This job is in stage Requires Input.'));
      assert(jobMarkdown.includes(bugMarker) && jobMarkdown.includes(replyMarker),
        'The original bug and its reply thread should render on the converted job');
      assert(jobMarkdown.includes(questionMarker) && jobMarkdown.includes(optionOne) &&
        jobMarkdown.includes(optionTwo), 'The converted job should hold the optioned question');
      assert(jobMarkdown.includes('This job is in stage Requires Input.'),
        'The AI question should interrupt the newly Doable Bugs job');

      const movedComments = await pollFor(
        () => listMarketComments(),
        (comments) => {
          const root = comments.find((comment) => comment.id === originalBug.id);
          const reply = comments.find((comment) => comment.id === originalReply.id);
          const question = comments.find((comment) => comment.body?.includes(questionMarker));
          return root?.comment_type === 'TODO' && root.investible_id &&
            reply?.investible_id === root.investible_id && question?.ticket_code === questionCode;
        });
      const movedBug = movedComments.find((comment) => comment.id === originalBug.id);
      const movedReply = movedComments.find((comment) => comment.id === originalReply.id);
      assert.strictEqual(movedBug.comment_type, 'TODO',
        'The original bug root should become a task rather than being copied');
      assert.strictEqual(movedReply.investible_id, movedBug.investible_id,
        'Every existing bug reply should move onto the same job');

      const createdQuestion = movedComments.find((comment) =>
        comment.body?.includes(questionMarker));
      assert(createdQuestion, 'The AI-authored question should be discoverable on the job');
      assert.strictEqual(createdQuestion.ticket_code, questionCode,
        'The returned question code should identify the created question');
      assert.notStrictEqual(createdQuestion.created_by, adminId,
        'The question should be authored by the workspace AI user');

      const fullJob = await pollFor(
        () => getFullInvestible(movedBug.investible_id),
        (investible) => investible?.market_infos?.some((info) => info.ticket_code === jobCode));
      assert(fullJob, 'The converted Bugs job should be readable through its source task');
      assert.strictEqual(fullJob.investible.created_by, adminId,
        'The converted Bugs job should be human-owned');
      assert.strictEqual(fullJob.investible.name, 'Bugs',
        'Bug conversion should use the dedicated Bugs job name');
      const fullJobInfo = fullJob.market_infos.find((info) => info.ticket_code === jobCode);
      assert(fullJobInfo?.assigned?.includes(adminId),
        'The human invoking ask_question should be assigned to the converted job');

      // Human Resolve delegates the option choice to the AI and releases the question lock.
      await adminClient.investibles.updateComment(createdQuestion.id, undefined, true);
      const restored = await pollFor(
        () => pollMcp('get_job', { short_code_id: jobCode }),
        (markdown) => markdown.includes('This job is in stage Doable.'));
      assert(restored.includes('This job is in stage Doable.'),
        'Resolving the converted question should restore the Bugs job to Doable');
    }).timeout(600000);

    it('keeps an open-ended bug question in the single-comment workflow', async () => {
      const marker = randomUUID();
      const bugMarker = `Bug needing reproduction details ${marker}`;
      const addedBug = await pollMcp('add_bug', { bug: bugMarker, severity: 'BLUE' });
      const bugCode = extractShortCode(addedBug);

      await assert.rejects(
        () => mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
          job_id: bugCode,
          question: `How can the bug be reproduced ${marker}?`
        }),
        /status 400/,
        'ask_question should reject bug conversion without answer options');

      const replyMarker = `Please provide the exact reproduction steps ${marker}.`;
      const replied = await pollMcp('add_info', {
        short_code_id: bugCode,
        info: replyMarker
      });
      assert(replied.includes('Added info with id'),
        `Open-ended bug question should use add_info: ${replied}`);
      const bugMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: bugCode }),
        (markdown) => markdown.includes(bugMarker) && markdown.includes(replyMarker));
      assert(bugMarkdown.includes(bugMarker) && bugMarkdown.includes(replyMarker),
        'The open-ended question should remain in the original bug thread');
      assert(!bugMarkdown.includes('# Job J-'),
        'An open-ended question must not create a job');
      const originalBug = await findCommentByMarker(bugMarker);
      assert(!originalBug.investible_id && originalBug.comment_type === 'TODO',
        'The bug should remain a view-level TODO after the rejected conversion');
    }).timeout(360000);
  });
}
