import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildCodexLaunch,
  isolatedSessionEnvironment
} from '../clientAdapters.js';
import {
  MAX_CODEX_REPORTED_TOKENS,
  assertSkillLoadedBeforeSemanticMcp,
  assertCodexUsageWithinCeiling
} from '../semanticAssertions.js';
import { executeSemanticHarness } from '../semanticHarness.js';
import {
  buildSemanticPlan,
  buildStandaloneBugConversionPlan
} from '../semanticScenarios.js';

describe('agent dev Codex semantic harness mechanics', () => {
  it('plans exactly three independent Codex phases with unique keys and traces', () => {
    const plan = buildSemanticPlan();
    const standaloneBugPlan = buildStandaloneBugConversionPlan();

    assert.strictEqual(plan.length, 3);
    assert.deepStrictEqual(plan.map((session) => session.phase), [
      'advisory-stop',
      'primary-resume',
      'bug-conversion'
    ]);
    assert(plan.every((session) => session.client === 'codex'));
    assert(plan.every((session) => session.codexSandbox === 'read-only'));
    assert.strictEqual(new Set(plan.map((session) => session.key)).size, plan.length);
    assert.strictEqual(new Set(plan.map((session) => session.traceName)).size, plan.length);
    assert.deepStrictEqual(standaloneBugPlan.map((session) => ({
      phase: session.phase,
      key: session.key,
      traceName: session.traceName
    })), [{
      phase: 'bug-conversion',
      key: 'codex-semantic/standalone-bug-conversion',
      traceName: 'codex-semantic-standalone-bug-conversion.jsonl'
    }]);
    assert.strictEqual(new Set(standaloneBugPlan.map((session) => session.key)).size, 1);
    assert.strictEqual(new Set(standaloneBugPlan.map((session) => session.traceName)).size, 1);
  });

  it('launches semantic Codex read-only with isolated defaults and no model or effort override', () => {
    const fixture = {
      workspace: '/tmp/semantic-workspace',
      sessionHome: '/tmp/semantic-home',
      proxyPath: '/tmp/uclusionMCPProxy.py',
      marketId: 'market-unit',
      bridgeActive: true,
      proxyEnvironment: { TEST_AGENT_DEV_SESSION: 'unit' }
    };
    const launch = buildCodexLaunch({
      fixture,
      prompt: 'Handle J-unit.',
      codexOtelEndpoint: 'http://127.0.0.1:4318/v1/logs',
      sandbox: 'read-only'
    });
    const childEnv = isolatedSessionEnvironment({
      PATH: '/bin',
      OPENAI_API_KEY: 'provider-key',
      CODEX_MODEL: 'forbidden-model',
      CODEX_REASONING_EFFORT: 'forbidden-effort',
      OPENAI_MODEL: 'also-forbidden',
      UCLUSION_CODEX_BRIDGE_ACTIVE: 'forbidden-parent-value',
      UCLUSION_DEV_CREDENTIALS: 'forbidden-parent-secret'
    }, 'codex', fixture);

    assert.deepStrictEqual(launch.args.slice(0, 4), [
      'exec', '--json', '--ephemeral', '--ignore-user-config'
    ]);
    assert.strictEqual(launch.args[launch.args.indexOf('--sandbox') + 1], 'read-only');
    assert.strictEqual(launch.args.at(-1), 'Handle J-unit.');
    assert(!launch.args.includes('--model'));
    assert(!launch.args.includes('-m'));
    assert(!launch.args.some((argument) =>
      /(?:model_reasoning_effort|reasoning_effort|(^|[.\s])model\s*=)/i.test(argument)));
    assert.strictEqual(childEnv.CODEX_API_KEY, 'provider-key');
    for (const name of [
      'OPENAI_API_KEY',
      'CODEX_MODEL',
      'CODEX_REASONING_EFFORT',
      'OPENAI_MODEL',
      'UCLUSION_DEV_CREDENTIALS'
    ]) {
      assert(!Object.hasOwn(childEnv, name), `${name} leaked into semantic Codex`);
    }
    assert.strictEqual(childEnv.HOME, fixture.sessionHome);
    assert.strictEqual(childEnv.CODEX_HOME, path.join(fixture.sessionHome, '.codex'));
    assert.strictEqual(childEnv.UCLUSION_CODEX_BRIDGE_ACTIVE, '1');

    const expectedSkillPath = path.join(
      fixture.sessionHome,
      '.agents',
      'skills',
      'uclusion',
      'SKILL.md'
    );
    const expectedSkillContent = '# Unit workflow\n<!-- /uclusion-skill:v1 -->\n';
    const parsed = {
      skillEndSentinel: '<!-- /uclusion-skill:v1 -->',
      sentinelEventIndexes: [4],
      toolCalls: [{ name: 'mcp__Uclusion__get_job', eventIndex: 5 }],
      successfulReadEvidence: [
        {
          name: 'Shell',
          input: {
            command: '/bin/bash -lc "sed -n \'1,1p\' ' +
              '.agents/skills/uclusion/SKILL.md"'
          },
          eventIndex: 1,
          resultEventIndex: 2,
          fragments: [{ eventIndex: 2, text: '# Unit workflow\n' }]
        },
        {
          name: 'Shell',
          input: {
            command: '/bin/bash -lc "sed -n \'2,20p\' ' +
              ".agents/skills/uclusion/SKILL.md && printf '\\n---POKES---\\n' && " +
              "sed -n '1,20p' .agents/skills/uclusion/references/pokes.md\""
          },
          eventIndex: 3,
          resultEventIndex: 4,
          fragments: [{
            eventIndex: 4,
            text: '<!-- /uclusion-skill:v1 -->\n\n---POKES---\n# Reference\n'
          }]
        }
      ]
    };
    assert.doesNotThrow(() => assertSkillLoadedBeforeSemanticMcp(parsed, {
      expectedSkillPath,
      expectedSkillContent
    }));
    const spoofed = structuredClone(parsed);
    spoofed.successfulReadEvidence[1].input.command =
      '/bin/bash -lc "printf \'<!-- /uclusion-skill:v1 -->\\n\' && ' +
      'sed -n \'1,20p\' .agents/skills/uclusion/references/pokes.md"';
    assert.throws(() => assertSkillLoadedBeforeSemanticMcp(spoofed, {
      expectedSkillPath,
      expectedSkillContent
    }));
  });

  it('accepts exactly 500,000 reported tokens and fails closed above or on malformed usage', () => {
    assert.strictEqual(assertCodexUsageWithinCeiling({
      usage: { input_tokens: MAX_CODEX_REPORTED_TOKENS - 1, output_tokens: 1 }
    }), MAX_CODEX_REPORTED_TOKENS);

    for (const invalid of [
      { usage: { input_tokens: MAX_CODEX_REPORTED_TOKENS, output_tokens: 1 } },
      null,
      {},
      { usage: {} },
      { usage: { input_tokens: '1', output_tokens: 1 } },
      { usage: { input_tokens: -1, output_tokens: 1 } },
      { usage: { input_tokens: 1, output_tokens: 0.5 } }
    ]) {
      assert.throws(() => assertCodexUsageWithinCeiling(invalid));
    }
  });

  it('makes one paid runner call on failure and preserves bounded redacted artifacts and pins',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-semantic-mechanics-'));
      const artifactDir = path.join(root, 'artifacts');
      const seedPinsPath = path.join(root, 'seed-pins.json');
      const seedPins = Buffer.from('{"sentinel":"prior-pins"}\n');
      const secret = 'semantic-provider-secret-unit';
      fs.writeFileSync(seedPinsPath, seedPins);
      let paidCalls = 0;
      let outerCloses = 0;
      let phaseCloses = 0;
      // This stub exercises only orchestration failure mechanics. The runner
      // fails before any two-human or Uclusion semantic assertion can execute.
      const fakeFixture = {
        marketId: 'market-unit',
        sensitiveValues: () => [secret],
        async initialize() {},
        targets: () => ({
          authorityJobCode: 'J-unit-1',
          questionCode: 'Q-unit-1',
          taskCode: 'T-unit-1',
          bugCode: 'B-unit-1',
          advisoryEvent: 'Responded O-unit-1 of Q-unit-1',
          primaryEvent: 'Responded O-unit-2 of Q-unit-1',
          bugStartEvent: 'Start B-unit-1'
        }),
        async preparePhase(session) {
          const sessionHome = path.join(root, session.id);
          fs.mkdirSync(sessionHome, { recursive: true });
          const skillTarget = path.join(
            sessionHome,
            '.agents',
            'skills',
            'uclusion'
          );
          fs.mkdirSync(skillTarget, { recursive: true });
          fs.writeFileSync(
            path.join(skillTarget, 'SKILL.md'),
            '# Unit workflow\n<!-- /uclusion-skill:v1 -->\n'
          );
          return {
            workspace: sessionHome,
            sessionHome,
            proxyPath: path.join(sessionHome, 'uclusionMCPProxy.py'),
            proxyEnvironment: {},
            marketId: 'market-unit',
            runId: 'run-unit',
            bridgeActive: true,
            stagedSource: { skillTarget },
            sensitiveValues: [secret],
            async snapshot() { return {}; },
            async close() { phaseCloses += 1; }
          };
        },
        async snapshotSemantic() { return {}; },
        assertPhase() { assert.fail('semantic assertions must not run after process failure'); },
        async close() { outerCloses += 1; }
      };

      try {
        const result = await executeSemanticHarness({
          artifactDir,
          seedPinsPath,
          webUiRoot: root,
          timeoutMs: 600000,
          runId: 'run-unit',
          env: { PATH: '/bin', CODEX_API_KEY: secret },
          dependencies: {
            inspectSourcePackage: () => ({ files: {} }),
            preflightClient: () => ({ status: 'passed', client_version: 'codex-unit' }),
            createFixture: () => fakeFixture,
            async runAgentSession() {
              paidCalls += 1;
              return {
                processResult: {
                  timedOut: false,
                  traceLimitExceeded: false,
                  spawnError: null,
                  exitCode: 17,
                  signal: null,
                  callbackFailures: [],
                  stderrBytes: 4 * 1024 * 1024,
                  stderrRetainedBytes: 64,
                  stderr: `${secret}:${'x'.repeat(64)}\n` +
                    '[harness stderr truncated: 4194240 bytes omitted]\n'
                },
                invalidJsonLines: [],
                parsed: { toolCalls: [] },
                modelRecord: {}
              };
            }
          }
        });

        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(paidCalls, 1);
        assert.strictEqual(result.results.length, 1);
        assert.strictEqual(phaseCloses, 1);
        assert.strictEqual(outerCloses, 1);
        assert.deepStrictEqual(fs.readFileSync(result.store.pinsPath), seedPins);
        const manifest = fs.readFileSync(result.store.manifestPath, 'utf8');
        assert(!manifest.includes(secret));
        assert(manifest.includes('[REDACTED]'));
        assert(manifest.includes('stderr truncated'));
        assert(Buffer.byteLength(manifest, 'utf8') < 64 * 1024,
          'failure diagnostics must remain bounded');
        if (process.platform !== 'win32') {
          assert.strictEqual(fs.statSync(artifactDir).mode & 0o777, 0o700);
          assert.strictEqual(fs.statSync(result.store.traceDir).mode & 0o777, 0o700);
          for (const traceName of fs.readdirSync(result.store.traceDir)) {
            assert.strictEqual(
              fs.statSync(path.join(result.store.traceDir, traceName)).mode & 0o777,
              0o600
            );
          }
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
});
