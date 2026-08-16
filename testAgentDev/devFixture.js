import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import awsAmplify from 'aws-amplify';
import AWS from 'aws-sdk';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { WebSocketRunner } from '../src/WebSocketRunner.js';
import { mcpCall, mcpLogin, pollFor } from '../tests/commonTestFunctions.js';
import { DEV_PRIMARY_IDENTITY } from './devIdentities.js';
import { stageSourcePackage } from './sourcePackage.js';

const Amplify = awsAmplify.default;
const DEV_ENDPOINTS = Object.freeze({
  baseURL: 'https://dev.api.uclusion.com/v1',
  websocketURL: 'wss://dev.ws.uclusion.com/v1'
});

const INTEGRATION_TEST_SUB_TYPE = 'INTEGRATION_TEST';
const DELETE_FUNCTION = 'uclusion-markets-dev-markets_delete';
const LAMBDA_HTTP_TIMEOUT_MS = 210000;

const COGNITO = Object.freeze({
  userPoolId: 'us-west-2_DF7pMdI6r',
  userPoolWebClientId: '375e3ronmppclr3onap4ndguvi',
  region: 'us-west-2'
});

const LOCAL_CLIENT_AUTH = Object.freeze({
  claude: [{
    sourceRoot: (env, home) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    relativePath: '.credentials.json',
    targetRoot: '.claude'
  }],
  codex: [{
    sourceRoot: (env, home) => env.CODEX_HOME || path.join(home, '.codex'),
    relativePath: 'auth.json',
    targetRoot: '.codex'
  }],
  cursor: [{
    sourceRoot: (_env, home) => path.join(home, '.cursor'),
    relativePath: 'cli-config.json',
    targetRoot: '.cursor'
  }, {
    sourceRoot: (env, home) => env.XDG_CONFIG_HOME || path.join(home, '.config'),
    relativePath: path.join('cursor', 'auth.json'),
    targetRoot: '.config'
  }]
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function writeExecutable(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
}

function seedLocalClientAuth({ client, env, sessionHome, registerSensitiveValues }) {
  if (env.TEST_AGENT_DEV_USE_LOCAL_AUTH !== '1') {
    return;
  }
  const specifications = LOCAL_CLIENT_AUTH[client];
  assert(specifications, `No local authentication layout is defined for ${client}`);
  const sourceHome = env.HOME || os.homedir();
  for (const specification of specifications) {
    const sourcePath = path.join(
      specification.sourceRoot(env, sourceHome),
      specification.relativePath
    );
    const sourceStat = fs.lstatSync(sourcePath);
    assert(sourceStat.isFile() && !sourceStat.isSymbolicLink(),
      `Local ${client} authentication must be a regular file: ${sourcePath}`);
    const targetPath = path.join(
      sessionHome,
      specification.targetRoot,
      specification.relativePath
    );
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(targetPath, 0o600);
    registerSensitiveValues([fs.readFileSync(sourcePath, 'utf8')]);
  }
}

export function parseDevCredentials(env = process.env) {
  const raw = env.UCLUSION_DEV_CREDENTIALS;
  if (!raw?.trim()) {
    // The DEV-only Uclusion identity ships in the repo exactly like the
    // deterministic suites' checked-in users; the environment variable is
    // only an explicit override.
    return {
      raw: JSON.stringify(DEV_PRIMARY_IDENTITY),
      username: DEV_PRIMARY_IDENTITY.username,
      password: DEV_PRIMARY_IDENTITY.password
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('UCLUSION_DEV_CREDENTIALS is not valid JSON', { cause: error });
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    'UCLUSION_DEV_CREDENTIALS must be a JSON object');
  assert.strictEqual(typeof parsed.username, 'string',
    'UCLUSION_DEV_CREDENTIALS.username must be a string');
  assert.strictEqual(typeof parsed.password, 'string',
    'UCLUSION_DEV_CREDENTIALS.password must be a string');
  assert(parsed.username.trim(), 'UCLUSION_DEV_CREDENTIALS.username must not be empty');
  assert(parsed.password, 'UCLUSION_DEV_CREDENTIALS.password must not be empty');
  return {
    raw,
    username: parsed.username.trim(),
    password: parsed.password
  };
}

function machineCapability(marketId) {
  return { role: 'Machine', is_admin: true, type: 'market', id: marketId };
}

function decodeLambdaPayload(response) {
  assert.strictEqual(
    response.StatusCode,
    200,
    `${DELETE_FUNCTION} invocation failed with status ${response.StatusCode}`
  );
  const payloadText = Buffer.from(response.Payload || '').toString('utf8');
  let envelope;
  try {
    envelope = JSON.parse(payloadText);
  } catch (error) {
    assert.fail(`${DELETE_FUNCTION} returned invalid JSON`);
  }
  assert(!response.FunctionError && !envelope.errorMessage,
    `${DELETE_FUNCTION} failed: ${response.FunctionError || envelope.errorMessage}`);
  let body = envelope.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_error) {
      // Preserve the opaque body for the guarded assertion below.
    }
  }
  return { statusCode: envelope.statusCode, body };
}

export async function deleteIntegrationTestMarket(marketId, {
  lambdaFactory = () => new AWS.Lambda({
    region: COGNITO.region,
    maxRetries: 0,
    httpOptions: { timeout: LAMBDA_HTTP_TIMEOUT_MS }
  })
} = {}) {
  assert(marketId, 'Refusing fixture deletion without an exact market id');
  const response = await lambdaFactory().invoke({
    FunctionName: DELETE_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ capability: machineCapability(marketId) })
  }).promise();
  const result = decodeLambdaPayload(response);
  assert.strictEqual(result.statusCode, 200,
    `Cleanup delete failed for ${marketId}: ${JSON.stringify(result.body)}`);
  assert(
    ['Market deleted', 'Market already deleted'].includes(result.body?.success_message),
    `Unexpected cleanup response for ${marketId}: ${JSON.stringify(result.body)}`
  );
}

async function collectFixtureCleanupErrors({
  pokeSocket,
  fixtureRoot,
  releaseMarket,
  marketId,
  removeTree = (target) => fs.rmSync(target, { recursive: true, force: true })
}) {
  const errors = [];
  if (pokeSocket) {
    try {
      pokeSocket.terminate();
    } catch (error) {
      errors.push(error);
    }
  }
  if (fixtureRoot) {
    try {
      removeTree(fixtureRoot);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await releaseMarket(marketId);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

export async function cleanupFailedFixture({ setupError, ...cleanup }) {
  const cleanupErrors = await collectFixtureCleanupErrors(cleanup);
  if (cleanupErrors.length) {
    throw new AggregateError(
      [setupError, ...cleanupErrors],
      `Fixture setup and cleanup failed for ${cleanup.marketId}`
    );
  }
  throw setupError;
}

async function ticketCodeFor(adminClient, marketId, fullInvestible) {
  const marketInfo = fullInvestible.market_infos.find((info) => info.market_id === marketId) ||
    fullInvestible.market_infos[0];
  if (marketInfo.ticket_code) {
    return marketInfo.ticket_code;
  }
  return pollFor(async () => {
    const [current] = await adminClient.markets.getMarketInvestibles([{
      investible: { id: fullInvestible.investible.id, version: 1 },
      market_infos: [{ id: marketInfo.id, version: 1 }]
    }]);
    const info = current?.market_infos?.find((entry) => entry.market_id === marketId) ||
      current?.market_infos?.[0];
    return info?.ticket_code;
  }, Boolean, 20, 1000);
}

async function pollMcp(configuration, token, name, args) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await mcpCall(configuration, token, name, args);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

export function canonicalMarketSignature(versions, marketId) {
  const entry = (versions?.signatures || []).find((candidate) =>
    candidate.market_id === marketId);
  assert(entry, `Versions response omitted fixture market ${marketId}`);
  return (entry.signatures || []).map((signature) => ({
    type: signature.type,
    object_versions: (signature.object_versions || [])
      .map(stableObject)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  })).sort((left, right) => left.type.localeCompare(right.type));
}

function writeSessionFiles({
  fixtureRoot,
  workspace,
  sessionHome,
  marketId,
  secret,
  cliPath,
  shippedProxyPath,
  pokePersisted,
  expectedPoke
}) {
  const uclusionHome = path.join(sessionHome, '.uclusion');
  fs.mkdirSync(uclusionHome, { recursive: true });
  fs.writeFileSync(path.join(uclusionHome, 'dev_credentials'),
    `secret_key_id=${secret.external_id}_${secret.account_id}\n` +
    `secret_key=${secret.client_secret}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(uclusionHome, 'update_check.json'),
    `${JSON.stringify({ dev: { checked_at: Date.now() / 1000 } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'dev_uclusion.json'), `${JSON.stringify({
    workspaceId: marketId,
    extensionsList: ['json'],
    sourcesList: ['./probe.json'],
    uclusionMDFileType: 'report',
    uclusionMDFilePath: 'uclusion.md'
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, 'probe.json'),
    `${JSON.stringify({ alpha: 1, beta: 2 }, null, 2)}\n`);

  const wrapperPath = path.join(fixtureRoot, 'bin', 'uclusion-dev');
  const listenerLauncherPath = path.join(fixtureRoot, 'bin', 'uclusion-listener-ready.py');
  const proxyLauncherPath = path.join(fixtureRoot, 'bin', 'uclusion-proxy-persisted.py');
  writeExecutable(listenerLauncherPath, [
    '#!/usr/bin/env python3',
    'import importlib.util',
    'import os',
    'import pathlib',
    'import sys',
    `CLI_PATH = ${JSON.stringify(cliPath)}`,
    'spec = importlib.util.spec_from_file_location("uclusion_agent_dev_cli", CLI_PATH)',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'original_arm = module.start_new_consumer_at_arm_time',
    'def arm_and_signal(environment, workspace_id, consumer):',
    '    result = original_arm(environment, workspace_id, consumer)',
    '    ready = os.environ.get("TEST_AGENT_DEV_LISTENER_READY")',
    '    if ready:',
    '        target = pathlib.Path(ready)',
    '        temporary = target.with_name(target.name + ".tmp")',
    '        temporary.write_text("ready\\n", encoding="utf-8")',
    '        os.replace(temporary, target)',
    '    return result',
    'module.start_new_consumer_at_arm_time = arm_and_signal',
    'args = module.build_parser().parse_args()',
    'raise SystemExit(args.func(args) or 0)',
    ''
  ].join('\n'));
  writeExecutable(proxyLauncherPath, [
    '#!/usr/bin/env python3',
    'import importlib.util',
    'import os',
    'import pathlib',
    'import sys',
    `PROXY_PATH = ${JSON.stringify(shippedProxyPath)}`,
    'sys.path.insert(0, str(pathlib.Path(PROXY_PATH).parent))',
    'spec = importlib.util.spec_from_file_location("uclusion_agent_dev_proxy", PROXY_PATH)',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'original_enqueue = module.enqueue_prompt',
    'def enqueue_and_signal(environment, workspace_id, payload):',
    '    inserted = original_enqueue(environment, workspace_id, payload)',
    '    expected = os.environ.get("TEST_AGENT_DEV_EXPECTED_POKE")',
    '    ready = os.environ.get("TEST_AGENT_DEV_POKE_PERSISTED")',
    '    if expected and ready and payload.get("message") == expected:',
    '        target = pathlib.Path(ready)',
    '        temporary = target.with_name(target.name + ".tmp")',
    '        temporary.write_text("persisted\\n", encoding="utf-8")',
    '        os.replace(temporary, target)',
    '    return inserted',
    'module.enqueue_prompt = enqueue_and_signal',
    'raise SystemExit(module.main() or 0)',
    ''
  ].join('\n'));
  const gate = [
    'if [ "${1-} ${2-} ${3-} ${4-}" = "-e dev wait --timeout" ] && ' +
      '[ "${5-}" = "0" ] && [ -n "${TEST_AGENT_DEV_WAIT_GATE_READY-}" ]; then',
    '  : > "$TEST_AGENT_DEV_WAIT_GATE_READY"',
    '  gate_count=0',
    '  while [ ! -f "${TEST_AGENT_DEV_WAIT_GATE_RELEASE-}" ] && ' +
      '[ "$gate_count" -lt 300 ]; do',
    '    sleep 0.1',
    '    gate_count=$((gate_count + 1))',
    '  done',
    'fi'
  ].join('\n');
  writeExecutable(wrapperPath, [
    '#!/bin/sh',
    'set -eu',
    gate,
    'if [ "${1-} ${2-} ${3-}" = "-e dev listen" ]; then',
    `  exec env HOME=${shellQuote(sessionHome)} python3 ` +
      `${shellQuote(listenerLauncherPath)} "$@"`,
    'fi',
    `exec env HOME=${shellQuote(sessionHome)} python3 ${shellQuote(cliPath)} "$@"`,
    ''
  ].join('\n'));
  return {
    wrapperPath,
    listenerLauncherPath,
    proxyLauncherPath,
    proxyEnvironment: {
      HOME: sessionHome,
      TEST_AGENT_DEV_POKE_PERSISTED: pokePersisted,
      TEST_AGENT_DEV_EXPECTED_POKE: expectedPoke
    }
  };
}

async function waitForFile(filePath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for agent delivery gate ${filePath}`);
}

export async function deliverFixturePoke({
  pokeSocket,
  marketToken,
  message,
  pokePersisted,
  waitForPersisted = waitForFile,
  waitGateRelease = null,
  writeRelease = (target) => fs.writeFileSync(target, 'release\n')
}) {
  const receipt = pokeSocket.waitForReceivedMessage({
    event_type: 'poke_ai',
    message
  }, 30000);
  const persisted = waitForPersisted(pokePersisted);
  pokeSocket.pokeAI(marketToken, message);
  await Promise.all([receipt, persisted]);
  if (waitGateRelease) {
    writeRelease(waitGateRelease);
  }
}

export class DevFixtureFactory {
  constructor({ webUiRoot, runId, env = process.env, deleteMarket = deleteIntegrationTestMarket }) {
    this.webUiRoot = webUiRoot;
    this.runId = runId;
    this.env = env;
    this.deleteMarket = deleteMarket;
    this.activeMarkets = new Set();
    const credentials = parseDevCredentials(env);
    this.configuration = {
      ...DEV_ENDPOINTS,
      username: credentials.username,
      password: credentials.password
    };
    this.secretValues = new Set([credentials.raw, credentials.username, credentials.password]);
  }

  sensitiveValues() {
    return [...this.secretValues].filter(Boolean);
  }

  registerSensitiveValues(values) {
    const visit = (value) => {
      if (typeof value === 'string' && value) {
        this.secretValues.add(value);
      } else if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(visit);
      }
    };
    visit(values || []);
  }

  async initialize() {
    global.fetch = fetch;
    global.AbortController = AbortController;
    Amplify.configure({ Auth: COGNITO });
    this.configuration.idToken = await loginUserToIdentity(this.configuration);
    this.registerSensitiveValues([this.configuration.idToken]);
    const accountLogin = await loginUserToAccountAndGetToken(this.configuration);
    this.accountClient = accountLogin.client;
    this.accountToken = accountLogin.accountToken;
    this.registerSensitiveValues([this.accountToken]);
  }

  async create(session) {
    const factory = this;
    // Keep both the market and probe-job names below the backend title limit
    // while retaining enough run/session entropy to correlate live artifacts.
    const marker = `${this.runId.slice(0, 8)}-${session.client}-${session.scenario}-` +
      randomUUID().slice(0, 12);
    const marketResult = await this.accountClient.markets.createMarket({
      name: `Agent dev ${marker}`,
      market_type: 'PLANNING'
    });
    const marketId = marketResult?.market?.id;
    assert(typeof marketId === 'string' && marketId,
      'Agent dev createMarket response omitted the created market id');
    this.activeMarkets.add(marketId);
    this.registerSensitiveValues([marketResult.market.invite_capability]);
    let fixtureRoot;
    let pokeSocket;
    try {
      assert.strictEqual(
        marketResult.market.market_sub_type,
        INTEGRATION_TEST_SUB_TYPE,
        'Agent dev fixture was not marked for guarded deletion'
      );
      await loginUserToMarketInvite(this.configuration, marketResult.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(this.configuration, marketId);
      const adminClient = marketLogin.client;
      const marketToken = marketLogin.marketToken;
      this.registerSensitiveValues([marketToken]);
      const admin = await adminClient.users.get();
      const doable = marketResult.stages.find((stage) => stage.name === 'Doable');
      assert(doable, 'Fresh planning fixture is missing the Doable stage');
      const job = await adminClient.investibles.create({
      groupId: marketId,
      stageId: doable.id,
      assignments: [admin.id],
      name: `Agent trigger probe ${marker}`,
      description: 'Live integration delivery probe. Loading this job completes the probe. After ' +
        'the one get_job call, do not call any other Uclusion tool (including add_info, audit, or ' +
        'find_work), do not persist a handoff, and return to the original user request. This ' +
        'fixture must remain unchanged.'
      });
      const targetShortCode = await ticketCodeFor(adminClient, marketId, job);
      assert(targetShortCode, 'Fresh harness job never received a short code');
      const uclusionToken = await mcpLogin(this.configuration, adminClient, marketId);
      this.registerSensitiveValues([uclusionToken]);
      await pollMcp(this.configuration, uclusionToken, 'find_work', {});
      const secret = await adminClient.users.getSecret();
      this.registerSensitiveValues([
        secret.client_secret,
        secret.external_id,
        secret.account_id,
        `${secret.external_id}_${secret.account_id}`
      ]);
      const capabilityReadyVersions = await pollFor(
        () => factory.accountClient.summaries.versions(factory.accountToken, [marketId]),
        (versions) => {
          const capabilities = canonicalMarketSignature(versions, marketId)
            .find((signature) => signature.type === 'market_capability');
          return (capabilities?.object_versions || []).length >= 2;
        },
        20,
        500
      );
      const readyCapabilities = canonicalMarketSignature(capabilityReadyVersions, marketId)
        .find((signature) => signature.type === 'market_capability');
      assert((readyCapabilities?.object_versions || []).length >= 2,
        'AI market capability did not converge before the durable baseline snapshot');

    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclusion-agent-dev-'));
    const workspace = path.join(fixtureRoot, 'workspace');
    const sessionHome = path.join(fixtureRoot, 'home');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionHome, { recursive: true });
    seedLocalClientAuth({
      client: session.client,
      env: this.env,
      sessionHome,
      registerSensitiveValues: (values) => this.registerSensitiveValues(values)
    });
    const cliPath = path.join(this.webUiRoot, 'public', 'scripts', 'uclusionCLI.py');
    const shippedProxyPath = path.join(
      this.webUiRoot, 'public', 'scripts', 'uclusionMCPProxy.py');
    assert(fs.existsSync(cliPath), `Missing dev CLI source ${cliPath}`);
    assert(fs.existsSync(shippedProxyPath), `Missing dev MCP proxy source ${shippedProxyPath}`);
    const pokePersisted = path.join(fixtureRoot, 'poke-persisted.ready');
    const expectedPoke = `Start ${targetShortCode}`;
    const {
      wrapperPath,
      listenerLauncherPath,
      proxyLauncherPath,
      proxyEnvironment
    } = writeSessionFiles({
      fixtureRoot,
      workspace,
      sessionHome,
      marketId,
      secret,
      cliPath,
      shippedProxyPath,
      pokePersisted,
      expectedPoke
    });
    const expectedCliCommand = `${wrapperPath} -e dev`;
    const stagedSource = stageSourcePackage({
      webUiRoot: this.webUiRoot,
      workspace,
      client: session.client,
      cliCommand: expectedCliCommand
    });
    pokeSocket = new WebSocketRunner({
      wsUrl: this.configuration.websocketURL,
      reconnectInterval: 3000
    });
    pokeSocket.connect();
    await pokeSocket.waitForOpen();
    pokeSocket.subscribe(marketToken, true);
    const waitGateReady = path.join(fixtureRoot, 'wait-gate.ready');
    const waitGateRelease = path.join(fixtureRoot, 'wait-gate.release');
    const listenerReady = path.join(fixtureRoot, 'listener.ready');
      const reference = {
      investible: { id: job.investible.id, version: 1 },
      market_infos: [{
        id: (job.market_infos.find((info) => info.market_id === marketId) || job.market_infos[0]).id,
        version: 1
      }]
    };
      let closed = false;
      const fixtureSecrets = [
        marketToken,
        uclusionToken,
        secret.client_secret,
        `${secret.external_id}_${secret.account_id}`,
        marketResult.market.invite_capability
      ].filter(Boolean);
      return {
      runId: this.runId,
      marker,
      marketId,
      marketToken,
      adminClient,
      job,
      reference,
      targetShortCode,
      targetName: job.investible.name,
      fixtureRoot,
      workspace,
      sessionHome,
      cliPath,
      shippedProxyPath,
      proxyPath: proxyLauncherPath,
      proxyEnvironment,
      wrapperPath,
      listenerLauncherPath,
      expectedCliCommand,
      waitGateReady,
      waitGateRelease,
      listenerReady,
      pokePersisted,
      stagedSource,
      pokeSocket,
      sensitiveValues: fixtureSecrets,
      async snapshot() {
        const [current, versions] = await Promise.all([
          adminClient.markets.getMarketInvestibles([reference]).then((values) => values[0]),
          factory.accountClient.summaries.versions(factory.accountToken, [marketId])
        ]);
        const info = current.market_infos.find((entry) => entry.market_id === marketId) ||
          current.market_infos[0];
        return {
          market_id: marketId,
          investible_id: current.investible.id,
          ticket_code: info.ticket_code,
          name: current.investible.name,
          description: current.investible.description,
          stage_id: info.stage,
          assignments: [...(info.assignments || current.investible.assignments || [])].sort(),
          deleted: Boolean(current.investible.deleted),
          resolved: Boolean(current.investible.resolved),
          // Every visible market object and version is included, so adding a
          // comment/task/job/audit is a durable mutation even if root fields stay fixed.
          market_signature: canonicalMarketSignature(versions, marketId)
        };
      },
      async sendPoke() {
        if (session.client === 'claude') {
          await waitForFile(listenerReady);
        } else {
          await waitForFile(waitGateReady);
        }
        await deliverFixturePoke({
          pokeSocket,
          marketToken,
          message: expectedPoke,
          pokePersisted,
          waitGateRelease: session.client === 'claude' ? null : waitGateRelease
        });
      },
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        const errors = await collectFixtureCleanupErrors({
          pokeSocket,
          fixtureRoot,
          releaseMarket: (id) => factory.releaseMarket(id),
          marketId
        });
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors,
            `Multiple fixture cleanup operations failed for ${marketId}`);
        }
      }
      };
    } catch (error) {
      await cleanupFailedFixture({
        setupError: error,
        pokeSocket,
        fixtureRoot,
        releaseMarket: (id) => this.releaseMarket(id),
        marketId
      });
    }
  }

  async releaseMarket(marketId) {
    if (!this.activeMarkets.has(marketId)) {
      return;
    }
    await this.deleteMarket(marketId);
    this.activeMarkets.delete(marketId);
  }

  async close() {
    const marketIds = [...this.activeMarkets];
    const outcomes = await Promise.allSettled(
      marketIds.map((marketId) => this.releaseMarket(marketId))
    );
    const failures = outcomes
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, 'One or more agent dev markets failed guarded cleanup');
    }
  }
}
