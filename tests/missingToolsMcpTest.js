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

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      const result = await accountClient.markets.createMarket({
        name: 'Missing tools MCP integration',
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
      const upload = JSON.parse(uploadResponse);
      assert(upload.file_url?.includes('imagecdn.uclusion.com'),
        `get_upload should return an imagecdn file_url: ${uploadResponse}`);
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
      assert(jobMarkdown.includes('authorization='),
        'get_job should authorize the attached image URL');
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
  });
}
