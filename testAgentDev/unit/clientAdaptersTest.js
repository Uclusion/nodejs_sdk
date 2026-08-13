import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isolatedSessionEnvironment,
  runAgentSession,
  verifyClaudeHeadlessTools
} from '../clientAdapters.js';

describe('agent dev client orchestration', () => {
  it('isolates each client home and exposes only its provider credential', () => {
    const fixture = { sessionHome: '/tmp/agent-session-home' };
    const source = {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
      CURSOR_API_KEY: 'cursor-secret',
      UCLUSION_DEV_CREDENTIALS: 'uclusion-secret',
      UCLUSION_CODEX_BRIDGE_ACTIVE: '1',
      CODEX_MODEL: 'forced-model',
      AWS_ACCESS_KEY_ID: 'aws-key',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_SESSION_TOKEN: 'aws-session',
      ACTIONS_RUNTIME_TOKEN: 'github-token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
      OPENAI_BASE_URL: 'https://override.invalid',
      ANTHROPIC_BASE_URL: 'https://override.invalid',
      CURSOR_API_ENDPOINT: 'https://override.invalid'
    };

    const claude = isolatedSessionEnvironment(source, 'claude', fixture);
    const codex = isolatedSessionEnvironment(source, 'codex', fixture);
    const cursor = isolatedSessionEnvironment(source, 'cursor', fixture);

    assert.strictEqual(claude.ANTHROPIC_API_KEY, 'anthropic-secret');
    assert(!('OPENAI_API_KEY' in claude));
    assert(!('CURSOR_API_KEY' in claude));
    assert.strictEqual(codex.CODEX_API_KEY, 'openai-secret');
    assert(!('ANTHROPIC_API_KEY' in codex));
    assert(!('CURSOR_API_KEY' in codex));
    assert.strictEqual(cursor.CURSOR_API_KEY, 'cursor-secret');
    assert(!('ANTHROPIC_API_KEY' in cursor));
    assert(!('OPENAI_API_KEY' in cursor));
    for (const current of [claude, codex, cursor]) {
      assert.strictEqual(current.HOME, fixture.sessionHome);
      assert(!('UCLUSION_DEV_CREDENTIALS' in current));
      assert(!('UCLUSION_CODEX_BRIDGE_ACTIVE' in current));
      assert(!('CODEX_MODEL' in current));
      assert(!('AWS_ACCESS_KEY_ID' in current));
      assert(!('AWS_SECRET_ACCESS_KEY' in current));
      assert(!('AWS_SESSION_TOKEN' in current));
      assert(!('ACTIONS_RUNTIME_TOKEN' in current));
      assert(!('ACTIONS_ID_TOKEN_REQUEST_TOKEN' in current));
      assert(!('OPENAI_BASE_URL' in current));
      assert(!('ANTHROPIC_BASE_URL' in current));
      assert(!('CURSOR_API_ENDPOINT' in current));
    }
  });

  it('starts the real-Poke gate waiter concurrently for bare Codex', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-adapter-unit-'));
    const tracePath = path.join(workspace, 'trace.jsonl');
    let pokeCalls = 0;
    let pokeWasWaitingWhenClientStarted = false;
    let launchArgs;
    const session = {
      client: 'codex',
      scenario: 'first-poke',
      key: 'codex/first-poke',
      prompt: 'Read probe.json.'
    };
    const fixture = {
      workspace,
      proxyPath: path.join(workspace, 'uclusionMCPProxy.py'),
      marketId: 'market-unit',
      sessionHome: path.join(workspace, 'home'),
      runId: 'run-unit',
      waitGateReady: path.join(workspace, 'gate.ready'),
      waitGateRelease: path.join(workspace, 'gate.release'),
      targetShortCode: 'J-unit-1',
      proxyEnvironment: {
        HOME: path.join(workspace, 'home'),
        TEST_AGENT_DEV_POKE_PERSISTED: path.join(workspace, 'persisted'),
        TEST_AGENT_DEV_EXPECTED_POKE: 'Start J-unit-1'
      }
    };
    fs.mkdirSync(fixture.sessionHome);

    const result = await runAgentSession({
      session,
      fixture,
      tracePath,
      timeoutMs: 1000,
      clientVersion: 'codex-unit',
      sendPoke() {
        pokeCalls += 1;
        return Promise.resolve();
      },
      async processRunner({ args }) {
        launchArgs = args;
        pokeWasWaitingWhenClientStarted = pokeCalls === 1;
        fs.writeFileSync(tracePath, `${JSON.stringify({
          type: 'thread.started',
          thread_id: 'fresh-codex-unit-session',
          message: 'Start J-unit-1'
        })}\n`);
        return {
          timedOut: false,
          spawnError: null,
          exitCode: 0,
          callbackFailures: [],
          invalidJsonLines: [],
          stdout: '',
          stderr: '',
          events: []
        };
      },
      telemetryFactory: async () => ({
        endpoint: 'http://127.0.0.1:4321/v1/logs',
        async resolvedModel(threadId) {
          assert.strictEqual(threadId, 'fresh-codex-unit-session');
          return 'codex-live-default-unit';
        },
        async close() {}
      })
    });

    assert.strictEqual(pokeWasWaitingWhenClientStarted, true);
    assert.strictEqual(pokeCalls, 1);
    assert.strictEqual(result.modelRecord.primary_session_id, 'fresh-codex-unit-session');
    assert(launchArgs.some((arg) =>
      arg.includes('otlp-http') && arg.includes('protocol="binary"')),
    'Codex invocation must use the protobuf protocol accepted by its receiver');
    const mcpOverride = launchArgs.find((arg) => arg.startsWith('mcp_servers.Uclusion='));
    assert.match(mcpOverride,
      /env = \{ "HOME" = "[^"]+", "TEST_AGENT_DEV_POKE_PERSISTED" = "[^"]+", "TEST_AGENT_DEV_EXPECTED_POKE" = "Start J-unit-1" \}/);
    assert(!mcpOverride.includes('"HOME":'),
      'Codex config override must use TOML assignments, not JSON colons');
  });

  it('passes the Claude prompt outside variadic flags and requires advertised Monitor',
    async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-claude-unit-'));
    const tracePath = path.join(workspace, 'trace.jsonl');
    const sessionHome = path.join(workspace, 'home');
    fs.mkdirSync(sessionHome);
    const prompt = 'Hello from exact argv regression.';
    const fixture = {
      workspace,
      proxyPath: path.join(workspace, 'uclusionMCPProxy.py'),
      marketId: 'market-unit',
      sessionHome,
      runId: 'run-unit',
      expectedCliCommand: '/tmp/uclusion-dev -e dev',
      targetShortCode: 'J-unit-1'
    };
    let launchArgs;
    const result = await runAgentSession({
      session: {
        client: 'claude', scenario: 'session-start', key: 'claude/session-start', prompt
      },
      fixture,
      tracePath,
      timeoutMs: 1000,
      clientVersion: 'claude-unit',
      async sendPoke() {},
      async processRunner({ args }) {
        launchArgs = args;
        const sessionId = args[args.indexOf('--session-id') + 1];
        const events = [{
          type: 'system', subtype: 'init', session_id: sessionId,
          model: 'claude-exact-unit', tools: ['Read', 'Skill', 'Monitor']
        }, {
          type: 'assistant',
          message: {
            model: 'claude-exact-unit',
            content: [{
              type: 'tool_use', id: 'monitor-call', name: 'Monitor',
              input: { command: `${fixture.expectedCliCommand} listen`, persistent: true }
            }]
          }
        }, {
          type: 'user',
          message: { content: [{
            type: 'tool_result', tool_use_id: 'monitor-call', content: 'Monitor started'
          }] },
          toolUseResult: { taskId: 'monitor-task' }
        }];
        fs.writeFileSync(tracePath, `${events.map(JSON.stringify).join('\n')}\n`);
        return {
          timedOut: false,
          traceLimitExceeded: false,
          spawnError: null,
          exitCode: 0,
          callbackFailures: [],
          invalidJsonLines: [],
          stdout: '', stderr: '', events: []
        };
      }
    });
    assert.strictEqual(launchArgs.at(-1), prompt);
    assert(!launchArgs.includes('--tools'),
      'Claude --tools is variadic and must not consume the positional prompt');
    assert.strictEqual(result.modelRecord.resolved_model, 'claude-exact-unit');
  });

  it('preflights required Claude headless tools in an isolated zero-dollar invocation', () => {
    let observed;
    assert.strictEqual(verifyClaudeHeadlessTools({
      command: 'claude',
      probeEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'only-this-provider-key' },
      run(command, args, env) {
        observed = { command, args, env };
        return {
          status: 1,
          signal: null,
          error: null,
          stdout: `${JSON.stringify({
          type: 'system', subtype: 'init', tools: ['Monitor', 'TaskList', 'Skill', 'Read']
          })}\n${JSON.stringify({ type: 'result', total_cost_usd: 0 })}\n`,
          stderr: 'budget exhausted before model request'
        };
      }
    }), true);
    assert.strictEqual(observed.command, 'claude');
    assert(observed.args.includes('--verbose'));
    assert(observed.args.includes('--safe-mode'));
    assert(!observed.args.includes('--max-budget-usd'));
    assert.deepStrictEqual(observed.env, {
      PATH: '/bin', ANTHROPIC_API_KEY: 'test-agent-dev-intentionally-invalid-key'
    });

    assert.throws(() => verifyClaudeHeadlessTools({
      command: 'claude',
      probeEnv: {},
      run: () => ({ error: null, stdout: `${JSON.stringify({
        type: 'system', subtype: 'init', tools: ['Read', 'Skill']
      })}\n${JSON.stringify({ type: 'result', total_cost_usd: 0 })}\n`, stderr: '' })
    }), /missing required tool Monitor/);
  });
});
