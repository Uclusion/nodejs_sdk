import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, pollFor, sleep } from './commonTestFunctions.js';

const CLI_ENVIRONMENT_BY_HOST = new Map([
  ['dev.api.uclusion.com', 'dev'],
  ['stage.api.uclusion.com', 'stage']
]);

// The shipped CLI lives in the uclusion_web_ui checkout, so prefer the variable
// the agent-dev runner already uses and fall back to a sibling checkout.
function resolveCliPath() {
  const roots = [];
  if (process.env.TEST_AGENT_DEV_WEB_UI_ROOT) {
    roots.push(process.env.TEST_AGENT_DEV_WEB_UI_ROOT);
  }
  roots.push(path.join(path.resolve(new URL('../..', import.meta.url).pathname), 'uclusion_web_ui'));
  for (const root of roots) {
    const candidate = path.join(root, 'public', 'scripts', 'uclusionCLI.py');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Task moves run through the real command line rather than a mocked parser, so
// argparse, credentials, transport and the backend are all covered at once.
export default function (adminConfiguration) {
  describe('#test task moves through the shipped CLI', () => {
    let accountClient;
    let adminClient;
    let accountToken;
    let marketId;
    let uclusionToken;
    let cliPath;
    let cliEnvironment;
    let sessionHome;
    let workspace;

    before(async function () {
      this.timeout(300000);
      cliEnvironment = CLI_ENVIRONMENT_BY_HOST.get(new URL(adminConfiguration.baseURL).host);
      cliPath = resolveCliPath();
      if (!cliEnvironment) {
        this.skip();
      }
      if (!cliPath) {
        // Visible as pending rather than silently green: without that checkout
        // there is no shipped command to run.
        this.skip();
      }
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      accountToken = accountLogin.accountToken;
      const created = await accountClient.markets.createMarket({
        name: 'Task move CLI integration',
        market_type: 'PLANNING'
      });
      marketId = created.market.id;
      await loginUserToMarketInvite(adminConfiguration, created.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);

      const secret = await adminClient.users.getSecret();
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclusion-cli-move-'));
      sessionHome = path.join(fixtureRoot, 'home');
      workspace = path.join(fixtureRoot, 'workspace');
      const uclusionHome = path.join(sessionHome, '.uclusion');
      fs.mkdirSync(uclusionHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(uclusionHome, `${cliEnvironment}_credentials`),
        `secret_key_id=${secret.external_id}_${secret.account_id}\n` +
        `secret_key=${secret.client_secret}\n`, { mode: 0o600 });
      fs.writeFileSync(path.join(uclusionHome, 'update_check.json'),
        `${JSON.stringify({ [cliEnvironment]: { checked_at: Date.now() / 1000 } })}\n`,
        { mode: 0o600 });
      fs.writeFileSync(path.join(workspace, `${cliEnvironment}_uclusion.json`),
        `${JSON.stringify({ workspaceId: marketId }, null, 2)}\n`);
    });

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
      const found = comments.find((comment) => comment.body?.includes(marker));
      assert(found, `No comment carrying ${marker}`);
      return found;
    }

    // Creates a task on a job through MCP, gives it a reply, and returns both so
    // a move can be checked to carry the thread rather than only the task.
    async function createTaskWithReply(jobCode, marker) {
      const taskMarker = `CLI move task ${marker}`;
      const added = await pollMcp('add_task', { job_id: jobCode, task: taskMarker });
      const taskCode = extractShortCode(added);
      const task = await findCommentByMarker(taskMarker);
      assert(task.investible_id, 'A task must start out attached to its job');
      const replyMarker = `CLI move reply ${marker}`;
      const reply = await adminClient.investibles.createComment(
        undefined, marketId, replyMarker, task.id);
      return { taskCode, task, reply };
    }

    function runCli(commandArguments) {
      const result = spawnSync('python3', [cliPath, '-e', cliEnvironment, ...commandArguments], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, HOME: sessionHome }
      });
      assert.strictEqual(result.status, 0,
        `CLI ${commandArguments[0]} exited ${result.status}: ${result.stdout}${result.stderr}`);
      return result.stdout;
    }

    function structuredContentOf(output) {
      const parsed = JSON.parse(output);
      const structured = parsed.structuredContent || parsed.result?.structuredContent;
      assert(structured, `CLI output carried no structuredContent: ${output}`);
      return structured;
    }

    it('moves a task into a job the same call creates, keeping its code and thread', async function () {
      this.timeout(300000);
      const marker = randomUUID();
      const sourceJob = await pollMcp('add_job', {
        name: `CLI move source ${marker}`,
        description: 'Source job for a task the CLI moves out.'
      });
      const sourceJobCode = extractShortCode(sourceJob);
      const { taskCode, task, reply } = await createTaskWithReply(sourceJobCode, marker);
      const sourceInvestibleId = task.investible_id;

      const output = runCli([
        'add_job',
        '--name', `CLI move destination ${marker}`,
        '--description', 'Created by the CLI to receive a deferred task.',
        '--task-short-code-id', taskCode,
        '--json'
      ]);
      const structured = structuredContentOf(output);
      assert.deepStrictEqual(structured.task_moves?.map((move) => move.short_code_id), [taskCode],
        `The CLI should report one task move: ${output}`);
      assert.strictEqual(structured.task_moves[0].status, 'moved',
        `The task should move: ${JSON.stringify(structured.task_moves[0])}`);

      const moved = await pollFor(
        () => listMarketComments(),
        (comments) => {
          const current = comments.find((comment) => comment.id === task.id);
          const currentReply = comments.find((comment) => comment.id === reply.id);
          return current?.investible_id && current.investible_id !== sourceInvestibleId
            && currentReply?.investible_id === current.investible_id;
        });
      const movedTask = moved.find((comment) => comment.id === task.id);
      const movedReply = moved.find((comment) => comment.id === reply.id);
      assert.strictEqual(movedTask.id, task.id, 'The move must keep the original task record');
      assert.strictEqual(movedTask.comment_type, 'TODO', 'A moved task stays a task');
      assert.strictEqual(movedTask.created_by, task.created_by,
        'A moved task keeps the author who raised it');
      assert(movedTask.investible_id && movedTask.investible_id !== sourceInvestibleId,
        'The task should now belong to the job the CLI created');
      assert.strictEqual(movedReply.investible_id, movedTask.investible_id,
        'The task reply should follow it onto the new job');

      const destinationMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: structured.short_code_id }),
        (markdown) => markdown.includes(taskCode));
      assert(destinationMarkdown.includes(taskCode),
        `The new job should render the moved task under its original code: ${destinationMarkdown}`);
    });

    it('moves a task out to a view level bug at the requested severity', async function () {
      this.timeout(300000);
      const marker = randomUUID();
      const sourceJob = await pollMcp('add_job', {
        name: `CLI convert source ${marker}`,
        description: 'Source job for a task the CLI converts to a bug.'
      });
      const sourceJobCode = extractShortCode(sourceJob);
      const { taskCode, task, reply } = await createTaskWithReply(sourceJobCode, marker);

      const output = runCli([
        'move_task_to_bug',
        '--task-short-code-id', taskCode,
        '--severity', 'normal',
        '--json'
      ]);
      const structured = structuredContentOf(output);
      assert.strictEqual(structured.short_code_id, taskCode,
        `The CLI should report the same short code: ${output}`);
      assert.strictEqual(structured.status, 'moved', `The task should move out: ${output}`);

      const converted = await pollFor(
        () => listMarketComments(),
        (comments) => {
          const current = comments.find((comment) => comment.id === task.id);
          const currentReply = comments.find((comment) => comment.id === reply.id);
          return current && !current.investible_id && !currentReply?.investible_id;
        });
      const convertedTask = converted.find((comment) => comment.id === task.id);
      const convertedReply = converted.find((comment) => comment.id === reply.id);
      assert.strictEqual(convertedTask.id, task.id, 'The conversion must keep the original record');
      assert.strictEqual(convertedTask.comment_type, 'TODO', 'A view level bug is still a task type');
      assert.strictEqual(convertedTask.notification_type, 'YELLOW',
        'The bug should carry the severity the command asked for');
      assert.strictEqual(convertedTask.created_by, task.created_by,
        'A converted task keeps the author who raised it');
      assert(!convertedTask.investible_id, 'A converted task should no longer belong to a job');
      assert(convertedReply && !convertedReply.investible_id,
        'The reply should leave the job with the task it belongs to');
    });
  });
}
