import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeHarness } from '../harness.js';

function dependencies({ failAt = null, closeFailAt = null } = {}) {
  let nextSession = 0;
  return {
    inspectSourcePackage: () => ({ exact: 'source-package' }),
    preflightClient: (client) => ({
      status: 'passed',
      client_version: `${client}-cli-exact`,
      probes: {}
    }),
    createFixtureFactory: () => ({
      async initialize() {},
      async create(session) {
        const index = nextSession;
        nextSession += 1;
        return {
          marketId: `market-${index}`,
          targetShortCode: `J-probe-${index}`,
          expectedCliCommand: `/tmp/${session.client}/uclusion -e dev`,
          stagedSource: { exact: session.client },
          async snapshot() {
            return { stage_id: 'doable', target: `J-probe-${index}` };
          },
          async sendPoke() {},
          async close() {
            if (session.key === closeFailAt) {
              throw new Error(`cleanup failure for ${session.key}`);
            }
          }
        };
      }
    }),
    runAgentSession: async ({ session, tracePath }) => {
      fs.writeFileSync(tracePath, `${JSON.stringify({ session: session.key })}\n`);
      if (session.key === failAt) {
        throw new Error(`semantic failure for ${session.key}`);
      }
      const primary = `fresh-session-${session.key}`;
      return {
        processResult: {
          timedOut: false,
          spawnError: null,
          exitCode: 0,
          callbackFailures: [],
          stderr: ''
        },
        invalidJsonLines: [],
        parsed: { toolCalls: [] },
        modelRecord: {
          client: session.client,
          scenario: session.scenario,
          client_version: `${session.client}-cli-exact`,
          resolved_model: `${session.client}-live-default-exact`,
          primary_session_id: primary,
          session_ids: [primary],
          source: 'live-default-no-model-override'
        }
      };
    },
    assertScenario() {}
  };
}

function setup() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifact-unit-'));
  const seedPinsPath = path.join(artifactDir, 'seed.json');
  const baseline = Buffer.from('{"prior":"known-good"}\n');
  fs.writeFileSync(seedPinsPath, baseline);
  return { artifactDir, seedPinsPath, baseline };
}

function assertArtifactContract(artifactDir) {
  const rootJson = fs.readdirSync(artifactDir)
    .filter((name) => name.endsWith('.json') && name !== 'seed.json').sort();
  assert.deepStrictEqual(rootJson, [
    'last-known-good.json',
    'manifest.json',
    'resolved-models.json'
  ]);
  const traces = fs.readdirSync(path.join(artifactDir, 'traces'))
    .filter((name) => name.endsWith('.jsonl'));
  assert.strictEqual(traces.length, 9);
}

describe('agent dev harness orchestration', () => {
  it('runs 9 fresh sessions and ratchets complete exact model pins on 9/9', async () => {
    const files = setup();
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'passing-run',
      dependencies: dependencies()
    });
    assert.strictEqual(result.status, 'passed');
    assert.strictEqual(result.results.length, 9);
    assert(result.results.every((entry) => entry.status === 'passed'));
    const pins = JSON.parse(fs.readFileSync(
      path.join(files.artifactDir, 'last-known-good.json'), 'utf8'));
    assert.strictEqual(pins.source_run_id, 'passing-run');
    assert.strictEqual(Object.keys(pins.clients).length, 3);
    for (const client of ['claude', 'codex', 'cursor']) {
      assert.strictEqual(Object.keys(pins.clients[client].scenarios).length, 3);
      assert.strictEqual(
        pins.clients[client].scenarios['session-start'].resolved_model,
        `${client}-live-default-exact`
      );
    }
    const models = JSON.parse(fs.readFileSync(
      path.join(files.artifactDir, 'resolved-models.json'), 'utf8'));
    assert.strictEqual(models.complete, true);
    assert.strictEqual(Object.keys(models.sessions).length, 9);
    assertArtifactContract(files.artifactDir);
  });

  it('preserves prior pins byte-for-byte and exact failure stack on 8/9', async () => {
    const files = setup();
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'failing-run',
      dependencies: dependencies({ failAt: 'codex/idle-find-work' })
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.results.length, 9);
    assert(files.baseline.equals(fs.readFileSync(
      path.join(files.artifactDir, 'last-known-good.json'))));
    const manifest = JSON.parse(fs.readFileSync(
      path.join(files.artifactDir, 'manifest.json'), 'utf8'));
    const failure = manifest.sessions['codex/idle-find-work'].failure;
    assert.match(failure.message, /semantic failure/);
    assert.match(failure.stack, /harnessTest\.js/);
    assertArtifactContract(files.artifactDir);
  });

  it('fails missing client credentials/capabilities instead of skipping sessions', async () => {
    const files = setup();
    const deps = dependencies();
    deps.preflightClient = (client) => {
      if (client === 'cursor') {
        throw new Error('Cursor is not logged in and CURSOR_API_KEY is not set');
      }
      return { status: 'passed', client_version: `${client}-exact`, probes: {} };
    };
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'preflight-failure',
      dependencies: deps
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.preflight.cursor.status, 'failed');
    assert.strictEqual(result.results.length, 0);
    assert(files.baseline.equals(fs.readFileSync(
      path.join(files.artifactDir, 'last-known-good.json'))));
    const manifest = JSON.parse(fs.readFileSync(
      path.join(files.artifactDir, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.status, 'failed');
    assert.match(manifest.preflight.cursor.failure.stack, /Cursor is not logged in/);
    assertArtifactContract(files.artifactDir);
  });

  it('fails the run when an awaited fixture cleanup fails', async () => {
    const files = setup();
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'cleanup-failure',
      dependencies: dependencies({ closeFailAt: 'claude/session-start' })
    });
    assert.strictEqual(result.status, 'failed');
    const failed = result.results.find((entry) =>
      entry.client === 'claude' && entry.scenario === 'session-start');
    assert.strictEqual(failed.status, 'failed');
    assert.match(failed.failure.message, /cleanup failure/);
    assert(files.baseline.equals(fs.readFileSync(
      path.join(files.artifactDir, 'last-known-good.json'))));
  });

  it('publishes final models before ratcheting and preserves the original flush failure', async () => {
    const files = setup();
    const deps = dependencies();
    const { ArtifactStore } = await import('../artifacts.js');
    const store = new ArtifactStore({ ...files, runId: 'final-flush-failure' });
    const finish = store.finish.bind(store);
    store.finish = (status) => {
      if (status === 'passed') {
        throw new Error('injected final manifest/models flush failure');
      }
      return finish(status);
    };
    deps.store = store;
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'final-flush-failure',
      dependencies: deps
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(JSON.stringify(result.fatal), /injected final manifest\/models flush failure/);
    assert(files.baseline.equals(fs.readFileSync(
      path.join(files.artifactDir, 'last-known-good.json'))));
  });

  it('registers and redacts provider, bootstrap, and cleanup secrets before diagnostics',
    async () => {
    const files = setup();
    const canaries = {
      provider: 'provider-preflight-canary-secret',
      uclusion: 'uclusion-bootstrap-canary-secret',
      awsAccess: 'aws-access-canary-secret',
      awsSecret: 'aws-secret-canary-secret',
      awsSession: 'aws-session-canary-secret'
    };
    const deps = dependencies();
    deps.preflightClient = (client) => ({
      status: 'passed',
      client_version: `${client}-exact`,
      nested: { stdout: `diagnostic accidentally included ${Object.values(canaries).join(' ')}` }
    });
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'provider-redaction',
      env: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: canaries.provider,
        UCLUSION_DEV_CREDENTIALS: canaries.uclusion,
        AWS_ACCESS_KEY_ID: canaries.awsAccess,
        AWS_SECRET_ACCESS_KEY: canaries.awsSecret,
        AWS_SESSION_TOKEN: canaries.awsSession
      },
      dependencies: deps
    });
    assert.strictEqual(result.status, 'passed');
    const manifest = fs.readFileSync(path.join(files.artifactDir, 'manifest.json'), 'utf8');
    for (const canary of Object.values(canaries)) {
      assert(!manifest.includes(canary));
    }
    assert(manifest.includes('[REDACTED]'));
  });

  it('redacts a generated fixture secret when create rejects before returning a fixture',
    async () => {
    const files = setup();
    const canary = 'dynamic-market-token-canary';
    const deps = dependencies();
    deps.createFixtureFactory = () => {
      const secrets = new Set();
      return {
        sensitiveValues: () => [...secrets],
        async initialize() {},
        async create() {
          secrets.add(canary);
          throw new Error(`fixture setup echoed ${canary}`);
        },
        async close() {}
      };
    };
    const result = await executeHarness({
      ...files,
      webUiRoot: '/unused/source',
      runId: 'dynamic-secret-failure',
      dependencies: deps
    });
    assert.strictEqual(result.status, 'failed');
    const manifest = fs.readFileSync(path.join(files.artifactDir, 'manifest.json'), 'utf8');
    assert(!manifest.includes(canary));
    assert(manifest.includes('[REDACTED]'));
  });
});
