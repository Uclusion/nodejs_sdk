import assert from 'assert';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import AWS from 'aws-sdk';
import { DevFixtureFactory } from './devFixture.js';
import { isolatedSessionEnvironment, preflightClient } from './clientAdapters.js';
import { runCapturedProcess, startBackgroundProcess } from './process.js';
import { serializeError } from './errors.js';
import { inspectSourcePackage } from './sourcePackage.js';
import {
  buildTokenBreakdownPlan,
  tokenBreakdownPrompt,
  TOKEN_BREAKDOWN_LINE_LABELS
} from './tokenBreakdownScenarios.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const NOTE_TIMEOUT_MS = 3 * 60 * 1000;
const REGION = 'us-west-2';
const EXPORT_FUNCTION = 'uclusion-markets-dev-markets_export';
const BREAKDOWN_KEYS = new Set([
  'method', 'status', 'reason', 'items', 'uclusion_total_tokens',
  'provider_total_tokens', 'model_requests', 'reasoning', 'client', 'counts'
]);
const ITEM_KEYS = ['arrival_tokens', 'estimated_tokens', 'line', 'total_tokens'];
// Lines every audited session produces: the skill, its bootstrap, the tools
// it loaded and the framing of the calls it made.
const REQUIRED_LINES = ['skills', 'bootstrap', 'tool_definitions', 'mcp_framing'];
const REQUIRED_LABELS = [
  'Skill and reference reads', 'Bootstrap block', 'MCP tool definitions', 'MCP framing'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function scriptsDir(webUiRoot) {
  return path.join(webUiRoot, 'public', 'scripts');
}

function claudeHookEvents(webUiRoot) {
  // Read from the installer under test so the hooks match a real install.
  const result = spawnSync('python3', ['-c', [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("i", ${JSON.stringify(
      path.join(scriptsDir(webUiRoot), 'uclusionInstall.py'))})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(json.dumps(list(m.CLAUDE_TOKEN_AUDIT_HOOK_EVENTS)))'
  ].join('\n')], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `Could not read Claude hook events: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function writeClaudeAuditSettings({ fixture, webUiRoot, port }) {
  const command = [
    'env', `HOME=${shellQuote(fixture.sessionHome)}`, 'python3',
    shellQuote(path.join(scriptsDir(webUiRoot), 'uclusionTokenAudit.py')),
    'hook', '--environment', 'dev', '--workspace-id', shellQuote(fixture.marketId),
    '--source', 'transcript', '--port', String(port)
  ].join(' ');
  const hooks = {};
  for (const [event, matcher] of claudeHookEvents(webUiRoot)) {
    hooks[event] = [{
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command, timeout: 60 }]
    }];
  }
  const settingsPath = path.join(fixture.workspace, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify({ hooks }, null, 2)}\n`);
}

function claudeProxyArgs(fixture, port) {
  return [
    fixture.proxyPath, fixture.marketId, 'dev',
    '--token-audit', '--token-audit-port', String(port),
    '--token-audit-source', 'transcript', '--token-audit-client', 'claude'
  ];
}

function enableCodexAudit(fixture, port) {
  const configPath = path.join(fixture.workspace, 'dev_uclusion.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.tokenAudit = { enabled: true, port };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function installTokenManifest(fixture, webUiRoot) {
  const source = path.join(scriptsDir(webUiRoot), 'token-manifest.json');
  assert(fs.existsSync(source), `The token manifest is missing at ${source}`);
  const target = path.join(fixture.sessionHome, '.uclusion', 'token-manifest.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

async function createAuditedJob(fixture, canary) {
  // The fixture's own probe job was created in Doable.
  const doableStageId = (fixture.job.market_infos.find((info) =>
    info.market_id === fixture.marketId) || fixture.job.market_infos[0]).stage;
  assert(doableStageId, 'Token breakdown fixture is missing the Doable stage');
  const admin = await fixture.adminClient.users.get();
  const job = await fixture.adminClient.investibles.create({
    groupId: fixture.marketId,
    stageId: doableStageId,
    assignments: [admin.id],
    name: `Token breakdown probe ${fixture.marker}`.slice(0, 80),
    description: 'Live token breakdown probe. Its test plan is to add one progress ' +
      `note and end the audit. ${canary}`
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [current] = await fixture.adminClient.markets.getMarketInvestibles([{
      investible: { id: job.investible.id, version: 1 },
      market_infos: [{ id: job.market_infos[0].id, version: 1 }]
    }]);
    const ticketCode = current?.market_infos?.[0]?.ticket_code;
    if (ticketCode) {
      return { job, ticketCode };
    }
    await sleep(1500);
  }
  throw new Error('The token breakdown probe job never received a short code');
}

async function rawJobComments(marketId, marketInvestibleId) {
  const lambda = new AWS.Lambda({ region: REGION, maxRetries: 2 });
  const response = await lambda.invoke({
    FunctionName: EXPORT_FUNCTION,
    InvocationType: 'RequestResponse',
    ClientContext: Buffer.from(JSON.stringify({
      custom: { capability: { role: 'Machine', is_admin: true, type: 'market', id: marketId } }
    })).toString('base64'),
    Payload: JSON.stringify({ market_investible_ids: [marketInvestibleId] })
  }).promise();
  const envelope = JSON.parse(Buffer.from(response.Payload || '').toString('utf8'));
  assert(!response.FunctionError && !envelope.errorMessage,
    `${EXPORT_FUNCTION} failed: ${response.FunctionError || envelope.errorMessage}`);
  const body = typeof envelope.body === 'string' ? JSON.parse(envelope.body) : envelope.body;
  const exported = body?.jobs?.[0] || {};
  return [...(exported.comments || []), ...(exported.resolved_comments || [])]
    .map(({ comment }) => comment);
}

async function waitForAuditNote(marketId, job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const comments = await rawJobComments(marketId, job.market_infos[0].id);
    const note = comments.find((comment) => comment.body?.includes('Agent token usage')
      && comment.body?.includes('Audit publication: <code>final</code>'));
    if (note) {
      return note;
    }
    await sleep(5000);
  }
  return null;
}

function newestFile(directory, accept) {
  let newest = null;
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (accept(entry.name)) {
        const modified = fs.statSync(full).mtimeMs;
        if (!newest || modified > newest.modified) {
          newest = { path: full, modified };
        }
      }
    }
  };
  visit(directory);
  return newest?.path || null;
}

function usageBreakdown({ webUiRoot, fixture, logPath, env }) {
  const result = spawnSync('python3', [
    path.join(scriptsDir(webUiRoot), 'uclusionCLI.py'), 'usage', '--session', logPath, '--json'
  ], { encoding: 'utf8', env: { ...env, HOME: fixture.sessionHome }, cwd: fixture.workspace });
  assert.strictEqual(result.status, 0,
    `uclusion usage failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return { text: result.stdout, breakdown: JSON.parse(result.stdout) };
}

export function assertNumbersOnlyBreakdown(breakdown, forbidden) {
  for (const key of Object.keys(breakdown)) {
    assert(BREAKDOWN_KEYS.has(key), `uclusion usage returned an unexpected field ${key}`);
  }
  for (const item of breakdown.items) {
    assert.deepStrictEqual(Object.keys(item).sort(), ITEM_KEYS,
      `uclusion usage returned an unexpected item shape: ${JSON.stringify(item)}`);
    for (const field of ['arrival_tokens', 'estimated_tokens', 'total_tokens']) {
      assert(Number.isSafeInteger(item[field]) && item[field] >= 0,
        `${item.line}.${field} is not a token count`);
    }
  }
  const text = JSON.stringify(breakdown);
  for (const value of forbidden) {
    assert(!text.includes(value), 'uclusion usage output contains session content');
  }
}

export function assertAuditNoteBreakdown(body, forbidden) {
  assert(body.includes('Uclusion lines:'), `The audit note has no Uclusion lines:\n${body}`);
  assert(!body.includes('Uclusion lines: unavailable'),
    `The audit note's Uclusion lines are unavailable:\n${body}`);
  for (const label of REQUIRED_LABELS) {
    assert(body.includes(label), `The audit note has no ${label} line:\n${body}`);
  }
  const lines = body.split('Uclusion lines:')[1].split(/<\/li>|\n/)[0];
  for (const entry of lines.split(';').map((part) => part.trim()).filter(Boolean)) {
    if (entry.startsWith('reasoning tokens excluded')) {
      continue;
    }
    const label = TOKEN_BREAKDOWN_LINE_LABELS.find((candidate) => entry.startsWith(candidate));
    assert(label, `Unexpected Uclusion line in the audit note: ${entry}`);
    assert.match(entry.slice(label.length),
      /^ [\d,]+ on arrival, [\d,]+ with re-sends(?: \([\d,]+ estimated\))?$/,
      `A Uclusion line holds more than numbers: ${entry}`);
  }
  for (const value of forbidden) {
    assert(!body.includes(value), 'The audit note contains session content');
  }
}

function assertUsageBreakdown(breakdown) {
  assert.notStrictEqual(breakdown.status, 'unavailable',
    `uclusion usage could not measure the session: ${JSON.stringify(breakdown)}`);
  assert(breakdown.provider_total_tokens > 0, 'uclusion usage found no provider tokens');
  assert(breakdown.uclusion_total_tokens > 0, 'uclusion usage found no Uclusion tokens');
  assert(breakdown.uclusion_total_tokens <= breakdown.provider_total_tokens,
    'uclusion usage charged Uclusion more than the session used');
  const totals = Object.fromEntries(breakdown.items.map((item) => [item.line, item.total_tokens]));
  for (const line of REQUIRED_LINES) {
    assert(totals[line] > 0, `uclusion usage reported no ${line} tokens`);
  }
}

async function flushClaudeAuditOutbox({ fixture, port, env, job, timeoutMs }) {
  // A one-shot Claude Code session exits with its MCP proxy, before the
  // collector's grace period publishes the final note. A long session's proxy
  // lives on; start one again on the same store so it publishes what is due.
  const proxy = startBackgroundProcess({
    command: 'python3',
    args: claudeProxyArgs(fixture, port),
    cwd: fixture.workspace,
    env: { ...env, ...fixture.proxyEnvironment }
  });
  try {
    return await waitForAuditNote(fixture.marketId, job, timeoutMs);
  } finally {
    proxy.stop();
  }
}

async function runClaudeSession({ fixture, prompt, port, env, timeoutMs, tracePath }) {
  const sessionId = randomUUID();
  const mcpPath = path.join(fixture.workspace, 'claude-mcp.json');
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    mcpServers: {
      Uclusion: {
        command: 'python3',
        args: claudeProxyArgs(fixture, port),
        env: fixture.proxyEnvironment
      }
    }
  }, null, 2)}\n`);
  // Unlike the other catalogs, the session is persisted: its transcript is
  // the log `uclusion usage` and the audit collector read.
  const processResult = await runCapturedProcess({
    command: process.env.TEST_AGENT_DEV_CLAUDE_BIN || 'claude',
    args: [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--session-id', sessionId,
      '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
      '--setting-sources', 'project',
      '--mcp-config', mcpPath, '--strict-mcp-config',
      prompt
    ],
    cwd: fixture.workspace,
    env,
    timeoutMs,
    tracePath
  });
  assert.strictEqual(processResult.timedOut, false, 'The Claude session timed out');
  assert.strictEqual(processResult.exitCode, 0,
    `The Claude session exited ${processResult.exitCode}: ${processResult.stderr}`);
  const logPath = newestFile(path.join(fixture.sessionHome, '.claude', 'projects'),
    (name) => name === `${sessionId}.jsonl`);
  assert(logPath, 'The Claude session left no transcript');
  return { logPath, processResult };
}

async function runCodexSession({ fixture, prompt, port, env, timeoutMs, tracePath, job, webUiRoot }) {
  const stopPath = path.join(fixture.fixtureRoot, 'codex-session.stop');
  const configPath = path.join(env.CODEX_HOME, 'config.toml');
  assert(!fs.existsSync(configPath), 'The native accounting fixture already has Codex settings');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const proxyArgs = [fixture.proxyPath, fixture.marketId, 'dev', '--codex-native',
    '--token-audit', '--token-audit-port', String(port),
    '--token-audit-source', 'codex', '--token-audit-client', 'codex'];
  const proxyEnv = Object.entries(fixture.proxyEnvironment).map(([key, value]) =>
    `${tomlString(key)}=${tomlString(value)}`).join(',');
  // Invocation overrides select a different runtime. Persist these settings
  // only in this fixture's private home so the native adapter sees the session.
  fs.writeFileSync(configPath, [
    'approval_policy="never"',
    'sandbox_mode="workspace-write"',
    '[features]',
    'plugins=false', 'apps=false', 'remote_plugin=false',
    `[projects.${tomlString(fixture.workspace)}]`,
    'trust_level="trusted"',
    '[mcp_servers.Uclusion]',
    'enabled=true', 'required=true', 'command="python3"',
    `args=${JSON.stringify(proxyArgs)}`,
    `env={${proxyEnv}}`,
    'env_vars=["CODEX_HOME"]',
    'default_tools_approval_mode="approve"', ''
  ].join('\n'), { mode: 0o600 });
  const command = [
    process.env.TEST_AGENT_DEV_CODEX_BIN || 'codex',
    prompt
  ];
  const helper = spawn('python3', [
    path.join(path.dirname(new URL(import.meta.url).pathname), 'tokenBreakdownCodexSession.py'),
    '--scripts', scriptsDir(webUiRoot),
    '--workspace', fixture.workspace,
    '--log', tracePath,
    '--stop', stopPath,
    '--timeout', String(Math.floor(timeoutMs / 1000)),
    '--', ...command
  ], { cwd: fixture.workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  helper.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => helper.on('exit', (code) => resolve(code)));
  let note;
  try {
    // The interactive session stays open after its turn, and its own proxy
    // publishes the audit note; it ends once that note is visible.
    note = await Promise.race([
      waitForAuditNote(fixture.marketId, job, timeoutMs),
      exited.then(() => null)
    ]);
  } finally {
    fs.writeFileSync(stopPath, 'stop\n');
  }
  const code = await exited;
  assert([0, 3].includes(code),
    `The native Codex helper failed or timed out (${code}): ${stderr}`);
  assert(note, `The native Codex session published no final audit note (helper exit ` +
    `${code}): ${stderr}`);
  const logPath = newestFile(path.join(fixture.sessionHome, '.codex', 'sessions'),
    (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
  assert(logPath, 'The Codex session left no rollout');
  return { logPath, note };
}

function redact(value, secrets) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text;
}

export async function executeTokenBreakdownHarness({
  artifactDir,
  marketCleanup,
  webUiRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runId = randomUUID(),
  env = process.env,
  sessions = buildTokenBreakdownPlan(),
  reportProgress = () => {}
}) {
  fs.mkdirSync(artifactDir, { recursive: true });
  inspectSourcePackage(webUiRoot);
  const factory = new DevFixtureFactory({ webUiRoot, runId, env, marketCleanup });
  const results = [];
  const secrets = new Set([env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.CODEX_API_KEY]);
  let fatal = null;
  try {
    for (const client of new Set(sessions.map((session) => session.client))) {
      preflightClient(client, env);
    }
    await factory.initialize();
    for (const session of sessions) {
      reportProgress(`Starting ${session.description}`);
      let fixture;
      const result = { status: 'failed', client: session.client, scenario: session.id };
      try {
        fixture = await factory.create(session);
        factory.sensitiveValues().forEach((value) => secrets.add(value));
        (fixture.sensitiveValues || []).forEach((value) => secrets.add(value));
        installTokenManifest(fixture, webUiRoot);
        const canary = `token-breakdown-canary-${randomUUID()}`;
        const { job, ticketCode } = await createAuditedJob(fixture, canary);
        const prompt = tokenBreakdownPrompt(session, ticketCode);
        const port = await freePort();
        const sessionEnv = isolatedSessionEnvironment(env, session.client, fixture);
        const tracePath = path.join(artifactDir, session.traceName);
        let logPath;
        let note;
        if (session.client === 'claude') {
          writeClaudeAuditSettings({ fixture, webUiRoot, port });
          ({ logPath } = await runClaudeSession({
            fixture, prompt, port, env: sessionEnv, timeoutMs, tracePath
          }));
          note = await flushClaudeAuditOutbox({
            fixture, port, env: sessionEnv, job, timeoutMs: NOTE_TIMEOUT_MS
          });
          assert(note, 'The Claude session published no final audit note');
        } else {
          enableCodexAudit(fixture, port);
          ({ logPath, note } = await runCodexSession({
            fixture, prompt, port, env: sessionEnv, timeoutMs, tracePath, job, webUiRoot
          }));
        }
        const forbidden = [canary, 'probe is done', prompt];
        assertAuditNoteBreakdown(note.body, forbidden);
        const usage = usageBreakdown({ webUiRoot, fixture, logPath, env: sessionEnv });
        assertUsageBreakdown(usage.breakdown);
        assertNumbersOnlyBreakdown(usage.breakdown, forbidden);
        Object.assign(result, {
          status: 'passed',
          audit_note: note.body,
          usage: usage.breakdown
        });
      } catch (error) {
        result.failure = serializeError(error);
      } finally {
        if (fixture) {
          try {
            await fixture.close();
          } catch (cleanupError) {
            result.status = 'failed';
            result.cleanup_failure = serializeError(cleanupError);
          }
        }
      }
      results.push(result);
      fs.writeFileSync(path.join(artifactDir, `${session.key}.json`),
        `${redact(result, secrets)}\n`, { mode: 0o600 });
      reportProgress(`${result.status === 'passed' ? 'Passed' : 'Failed'}: ${session.description}`);
      // A paid session that fails stops the catalog rather than paying for more.
      if (result.status !== 'passed') {
        break;
      }
    }
  } catch (error) {
    fatal = serializeError(error);
  } finally {
    try {
      await factory.close();
    } catch (cleanupError) {
      fatal = fatal || serializeError(cleanupError);
    }
  }
  const passed = !fatal && results.length === sessions.length &&
    results.every((result) => result.status === 'passed');
  fs.writeFileSync(path.join(artifactDir, 'summary.json'), `${redact({
    status: passed ? 'passed' : 'failed', run_id: runId, fatal, results: results.map(
      ({ status, client, scenario, failure }) => ({ status, client, scenario, failure }))
  }, secrets)}\n`, { mode: 0o600 });
  return { status: passed ? 'passed' : 'failed', results, fatal };
}
