import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { runCapturedProcess } from './process.js';
import { parseAgentTrace, singleResolvedModel } from './trace.js';
import { startCodexTelemetryReceiver } from './codexTelemetry.js';

const EXECUTABLES = Object.freeze({
  claude: process.env.TEST_AGENT_DEV_CLAUDE_BIN || 'claude',
  codex: process.env.TEST_AGENT_DEV_CODEX_BIN || 'codex',
  cursor: process.env.TEST_AGENT_DEV_CURSOR_BIN || 'cursor-agent'
});

const SAFE_COMMON_ENV = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'ComSpec', 'PATHEXT'
]);
const CLAUDE_CAPABILITY_PROBE_KEY = 'test-agent-dev-intentionally-invalid-key';

export function environmentForClient(env, client, { isolateProviders = true } = {}) {
  const result = {};
  for (const name of SAFE_COMMON_ENV) {
    if (env[name] !== undefined) {
      result[name] = env[name];
    }
  }
  if (isolateProviders) {
    if (client === 'claude' && env.ANTHROPIC_API_KEY) {
      result.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    } else if (client === 'codex') {
      const key = env.CODEX_API_KEY || env.OPENAI_API_KEY;
      if (key) {
        // Codex documents CODEX_API_KEY as the invocation-scoped automation
        // credential. OPENAI_API_KEY is accepted only as the CI secret source.
        result.CODEX_API_KEY = key;
      }
    } else if (client === 'cursor' && env.CURSOR_API_KEY) {
      result.CURSOR_API_KEY = env.CURSOR_API_KEY;
    }
  }
  return result;
}

function runProbe(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    error: result.error?.stack || null,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function requireSuccessfulProbe(probe, label) {
  assert.strictEqual(
    probe.status,
    0,
    `${label} failed: ${probe.error || probe.stderr || probe.stdout}`
  );
}

function parseJsonLines(text, label) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label} emitted non-JSON output`, { cause: error });
    }
  }
  return events;
}

export function verifyClaudeHeadlessTools({
  command,
  probeEnv,
  run = runProbe
}) {
  const isolatedProbeEnv = {
    ...probeEnv,
    // Force an authentication failure after system/init so this feature probe
    // cannot consume model tokens or fall back to an OAuth/keychain identity.
    ANTHROPIC_API_KEY: CLAUDE_CAPABILITY_PROBE_KEY
  };
  const capability = run(command, [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--safe-mode',
    'Reply with exactly OK and do not use tools.'
  ], isolatedProbeEnv);
  const events = parseJsonLines(capability.stdout, 'Claude headless capability probe');
  const init = events.filter((event) => event?.type === 'system' && event?.subtype === 'init');
  assert.strictEqual(init.length, 1,
    `Claude headless capability probe must emit exactly one system/init event; ` +
      `found ${init.length}: ${capability.error || capability.stderr}`);
  const tools = init[0].tools;
  assert(Array.isArray(tools), 'Claude system/init did not include its tool list');
  for (const required of ['Monitor', 'Skill', 'Read']) {
    assert(tools.includes(required),
      `Claude headless system/init is missing required tool ${required}`);
  }
  // Newer Claude builds defer TaskList behind ToolSearch, so the listener
  // precheck capability is reachable without appearing in the init list.
  assert(tools.includes('TaskList') || tools.includes('ToolSearch'),
    'Claude headless system/init exposes neither TaskList nor ToolSearch');
  assert(!capability.error, `Claude headless capability probe failed: ${capability.error}`);
  const result = events.find((event) => event?.type === 'result');
  assert(result, 'Claude headless capability probe did not emit its final result record');
  assert.strictEqual(result.total_cost_usd, 0,
    'Claude headless capability probe unexpectedly consumed model spend');
  return true;
}

export function preflightClient(client, env = process.env) {
  const command = EXECUTABLES[client];
  assert(command, `Unknown client ${client}`);
  const probeEnv = environmentForClient(env, client);
  const version = runProbe(command, ['--version'], probeEnv);
  requireSuccessfulProbe(version, `${client} version probe`);
  const help = runProbe(command, client === 'codex' ? ['exec', '--help'] : ['--help'], probeEnv);
  requireSuccessfulProbe(help, `${client} capability probe`);
  const helpText = `${help.stdout}\n${help.stderr}`;
  const requiredCapabilities = {
    claude: ['stream-json', '--mcp-config', '--include-hook-events', '--tools'],
    codex: ['--json', '--ephemeral', '--ignore-user-config'],
    cursor: ['stream-json', '--approve-mcps', '--trust', '--force']
  }[client];
  for (const capability of requiredCapabilities) {
    assert(helpText.includes(capability),
      `${client} is missing required scripted-agent capability ${capability}`);
  }

  let auth;
  if (client === 'claude') {
    verifyClaudeHeadlessTools({ command, probeEnv });
    auth = runProbe(command, ['auth', 'status'], probeEnv);
    requireSuccessfulProbe(auth, 'Claude authentication probe');
    let parsed;
    try {
      parsed = JSON.parse(auth.stdout);
    } catch (error) {
      assert.fail(`Claude auth status was not JSON: ${auth.stdout}\n${error.message}`);
    }
    assert.strictEqual(parsed.loggedIn, true, 'Claude is not logged in');
  } else if (client === 'codex') {
    auth = runProbe(command, ['login', 'status'], probeEnv);
    const invocationKey = env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
    if (!invocationKey) {
      requireSuccessfulProbe(auth, 'Codex authentication probe');
      assert.match(`${auth.stdout}\n${auth.stderr}`, /logged in/i,
        'Codex is not logged in and CODEX_API_KEY is not set');
    }
  } else {
    auth = runProbe(command, ['status'], probeEnv);
    requireSuccessfulProbe(auth, 'Cursor authentication probe');
    const hasApiKey = Boolean(env.CURSOR_API_KEY?.trim());
    assert(hasApiKey || !/not logged in/i.test(`${auth.stdout}\n${auth.stderr}`),
      'Cursor is not logged in and CURSOR_API_KEY is not set');
  }

  const versionText = `${version.stdout}\n${version.stderr}`.trim();
  assert(versionText, `${client} returned an empty client version`);
  return {
    status: 'passed',
    executable: command,
    client_version: versionText,
    capabilities_verified: true,
    authentication_verified: true
  };
}

export function isolatedSessionEnvironment(env, client, fixture) {
  const result = environmentForClient(env, client);
  result.HOME = fixture.sessionHome;
  result.XDG_CONFIG_HOME = path.join(fixture.sessionHome, '.config');
  result.XDG_CACHE_HOME = path.join(fixture.sessionHome, '.cache');
  result.CODEX_HOME = path.join(fixture.sessionHome, '.codex');
  result.CLAUDE_CONFIG_DIR = path.join(fixture.sessionHome, '.claude');
  result.CI = '1';
  if (client === 'codex' && fixture.bridgeActive === true) {
    // Presence alone tells the shipped workflow that the harness has already
    // established delivery; never copy a parent bridge value into the child.
    result.UCLUSION_CODEX_BRIDGE_ACTIVE = '1';
  }
  return result;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlInlineTable(values) {
  assert(values && typeof values === 'object' && !Array.isArray(values),
    'MCP proxy environment must be an object');
  return `{ ${Object.entries(values).map(([key, value]) =>
    `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`;
}

function codexMcpOverride(fixture) {
  const args = [fixture.proxyPath, fixture.marketId, 'dev']
    .map(tomlString).join(', ');
  return 'mcp_servers.Uclusion={ enabled = true, required = true, command = "python3", args = [' +
    `${args}], env = ${tomlInlineTable(fixture.proxyEnvironment)}, ` +
    'default_tools_approval_mode = "approve" }';
}

export function buildCodexLaunch({
  fixture,
  prompt,
  codexOtelEndpoint,
  sandbox = 'workspace-write'
}) {
  assert(codexOtelEndpoint, 'Codex requires a run-scoped OTel model receiver');
  assert(['read-only', 'workspace-write'].includes(sandbox),
    `Unsupported Codex sandbox policy ${sandbox}`);
  return {
    command: EXECUTABLES.codex,
    args: [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox', sandbox,
      '-C', fixture.workspace,
      '-c', codexMcpOverride(fixture),
      '-c', 'otel.exporter={ otlp-http={ endpoint=' +
        `${tomlString(codexOtelEndpoint)}, protocol="binary" } }`,
      '-c', 'otel.log_user_prompt=false',
      prompt
    ]
  };
}

function writeMcpConfigs(fixture) {
  const server = {
    command: 'python3',
    args: [fixture.proxyPath, fixture.marketId, 'dev'],
    env: fixture.proxyEnvironment
  };
  const claudePath = path.join(fixture.workspace, 'claude-mcp.json');
  fs.writeFileSync(claudePath, `${JSON.stringify({ mcpServers: { Uclusion: server } }, null, 2)}\n`);
  const cursorPath = path.join(fixture.workspace, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, `${JSON.stringify({ mcpServers: { Uclusion: server } }, null, 2)}\n`);
  return { claudePath, cursorPath };
}

function commandFor(
  client,
  fixture,
  prompt,
  configs,
  codexOtelEndpoint = null,
  codexSandbox = 'workspace-write'
) {
  const executable = EXECUTABLES[client];
  if (client === 'claude') {
    const sessionId = randomUUID();
    return {
      command: executable,
      expectedSessionId: sessionId,
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--include-hook-events',
        '--verbose',
        '--session-id', sessionId,
        '--no-session-persistence',
        '--permission-mode', 'bypassPermissions',
        '--dangerously-skip-permissions',
        '--setting-sources', 'project',
        '--mcp-config', configs.claudePath,
        '--strict-mcp-config',
        prompt
      ]
    };
  }
  if (client === 'codex') {
    return buildCodexLaunch({
      fixture,
      prompt,
      codexOtelEndpoint,
      sandbox: codexSandbox
    });
  }
  return {
    command: executable,
    args: [
      '-p',
      '--output-format', 'stream-json',
      '--trust',
      '--approve-mcps',
      '--force',
      '--workspace', fixture.workspace,
      prompt
    ]
  };
}

function flattenEventsFromTrace(tracePath) {
  const events = [];
  const invalid = [];
  const text = fs.readFileSync(tracePath, 'utf8');
  text.split('\n').forEach((line) => {
    if (!line.trim()) {
      return;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      invalid.push({
        error: 'INVALID_JSON',
        raw_bytes: Buffer.byteLength(line, 'utf8')
      });
    }
  });
  return { events, invalid };
}

function boundedProcessResult(processResult) {
  if (!processResult) {
    return undefined;
  }
  return {
    ...processResult,
    // Raw stdout already lives byte-for-byte in the trace and would only
    // bloat manifest.json. Keep exact bounded stderr because it has no other
    // artifact.
    stdout: undefined,
    events: undefined
  };
}

function agentResultRecord({
  session,
  clientVersion,
  launch,
  processResult,
  raw,
  parsed,
  model
}) {
  const structured = parsed || {
    toolCalls: [],
    sessionIds: [],
    modelCallIds: [],
    reportedUsage: null
  };
  return {
    processResult: boundedProcessResult(processResult),
    parsed: structured,
    invalidJsonLines: [
      ...(raw?.invalid || []),
      ...(processResult?.invalidJsonLines || [])
    ],
    modelRecord: {
      client: session.client,
      scenario: session.scenario,
      client_version: clientVersion,
      resolved_model: model || null,
      primary_session_id: launch.expectedSessionId || structured.sessionIds?.[0] || null,
      session_ids: structured.sessionIds || [],
      model_call_ids: structured.modelCallIds || [],
      model_selection: session.client === 'cursor' ? model || null : undefined,
      reported_usage: structured.reportedUsage || null,
      source: session.client === 'codex'
        ? 'codex-otel-conversation-start'
        : session.client === 'cursor'
          ? 'cursor-system-init-routing-identity'
          : 'claude-assistant-model-no-override'
    }
  };
}

export async function runAgentSession({
  session,
  fixture,
  tracePath,
  timeoutMs,
  clientVersion,
  sendPoke,
  processRunner = runCapturedProcess,
  telemetryFactory = startCodexTelemetryReceiver,
  sourceEnv = process.env
}) {
  const configs = writeMcpConfigs(fixture);
  const telemetry = session.client === 'codex' ? await telemetryFactory() : null;
  const launch = commandFor(
    session.client,
    fixture,
    session.prompt,
    configs,
    telemetry?.endpoint,
    session.codexSandbox || 'workspace-write'
  );
  const env = isolatedSessionEnvironment(sourceEnv, session.client, fixture);
  env.TEST_AGENT_DEV_RUN_ID = fixture.runId;
  env.TEST_AGENT_DEV_SESSION_KEY = session.key;
  if (session.scenario === 'first-poke' && session.client !== 'claude') {
    env.TEST_AGENT_DEV_WAIT_GATE_READY = fixture.waitGateReady;
    env.TEST_AGENT_DEV_WAIT_GATE_RELEASE = fixture.waitGateRelease;
  }
  if (session.scenario === 'first-poke' && session.client === 'claude') {
    env.TEST_AGENT_DEV_LISTENER_READY = fixture.listenerReady;
  }
  let pokePromise = null;
  let pokeTriggered = false;
  const triggerPoke = () => {
    if (!pokeTriggered && session.scenario === 'first-poke') {
      pokeTriggered = true;
      let pending;
      try {
        pending = sendPoke();
      } catch (error) {
        pending = Promise.reject(error);
      }
      // Convert the background Poke injection into an outcome immediately so
      // an early gate failure cannot become an unhandled rejection while the
      // client process is still running. The exact error is rethrown below.
      pokePromise = Promise.resolve(pending).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason })
      );
    }
    return pokePromise;
  };
  // Bare Codex and Cursor must issue the zero-timeout drain themselves. Start
  // the harness-side waiter alongside the client; sendPoke blocks on the
  // wrapper's gate, injects the real dev Poke, then releases that exact drain.
  if (session.scenario === 'first-poke' && session.client !== 'claude') {
    triggerPoke();
  }
  let processResult;
  let telemetryModel;
  let raw;
  let parsed;
  let model;
  let telemetryClosed = false;
  const closeTelemetry = async () => {
    if (telemetryClosed) {
      return;
    }
    telemetryClosed = true;
    await telemetry?.close();
  };
  try {
    processResult = await processRunner({
      ...launch,
      cwd: fixture.workspace,
      env,
      timeoutMs,
      tracePath,
      onJsonEvent: async (event) => {
        if (session.scenario !== 'first-poke' || session.client !== 'claude') {
          return;
        }
        const serialized = JSON.stringify(event);
        if (serialized.includes('"name":"Monitor"') &&
            serialized.includes(`${fixture.expectedCliCommand} listen`)) {
          await triggerPoke();
        }
      }
    });
    raw = flattenEventsFromTrace(tracePath);
    const expectedPoke = session.scenario === 'first-poke'
      ? `Start ${fixture.targetShortCode}`
      : null;
    parsed = parseAgentTrace(raw.events, expectedPoke, session.client);
    if (telemetry) {
      telemetryModel = await telemetry.resolvedModel(parsed.sessionIds[0]);
    }
    await closeTelemetry();
    if (pokePromise) {
      const outcome = await pokePromise;
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
    }
    if (session.scenario === 'first-poke' && !pokeTriggered) {
      throw new Error(
        `${session.client} never established the delivery call needed to inject a real Poke`
      );
    }
    model = session.client === 'codex'
      ? telemetryModel
      : singleResolvedModel(parsed);
    assert(parsed.sessionIds.length > 0,
      `${session.client} stream-json trace did not expose a session/thread/chat id`);
    if (launch.expectedSessionId) {
      assert(parsed.sessionIds.includes(launch.expectedSessionId),
        `${session.client} trace did not preserve requested fresh session id ` +
        launch.expectedSessionId);
    }
    return agentResultRecord({
      session,
      clientVersion,
      launch,
      processResult,
      raw,
      parsed,
      model
    });
  } catch (error) {
    let failure = error && typeof error === 'object'
      ? error
      : new Error(String(error));
    try {
      await closeTelemetry();
    } catch (closeError) {
      failure = new AggregateError(
        [failure, closeError],
        `${session.key} and its Codex telemetry cleanup both failed`
      );
    }
    failure.agentResult = agentResultRecord({
      session,
      clientVersion,
      launch,
      processResult,
      raw,
      parsed,
      model: model || telemetryModel
    });
    throw failure;
  }
}

export function executableFor(client) {
  return EXECUTABLES[client];
}
