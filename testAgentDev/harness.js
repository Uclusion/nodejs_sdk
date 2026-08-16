import assert from 'assert';
import { randomUUID } from 'crypto';
import { ArtifactStore } from './artifacts.js';
import { ratchetIfAllPassed } from './atomicJson.js';
import { assertScenario } from './assertions.js';
import { preflightClient, runAgentSession } from './clientAdapters.js';
import { DevFixtureFactory } from './devFixture.js';
import { serializeError } from './errors.js';
import { buildSessionMatrix, CLIENTS } from './matrix.js';
import { inspectSourcePackage } from './sourcePackage.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function pinDocument(runId, sourcePackage, preflight, results) {
  const clients = {};
  for (const client of CLIENTS) {
    const clientResults = results.filter((result) => result.client === client);
    clients[client] = {
      client_version: preflight[client].client_version,
      scenarios: Object.fromEntries(clientResults.map((result) => [
        result.scenario,
        {
          resolved_model: result.modelRecord.resolved_model,
          model_selection: result.modelRecord.model_selection,
          session_ids: result.modelRecord.session_ids,
          model_call_ids: result.modelRecord.model_call_ids
        }
      ]))
    };
  }
  return {
    schema_version: 1,
    source_run_id: runId,
    ratcheted_at: new Date().toISOString(),
    source_package: sourcePackage,
    clients
  };
}

export async function executeHarness({
  artifactDir,
  seedPinsPath,
  webUiRoot,
  timeoutMs = Number(process.env.TEST_AGENT_DEV_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  runId = randomUUID(),
  env = process.env,
  dependencies = {}
}) {
  const inspectSource = dependencies.inspectSourcePackage || inspectSourcePackage;
  const preflight = dependencies.preflightClient || preflightClient;
  const createFixtureFactory = dependencies.createFixtureFactory ||
    ((options) => new DevFixtureFactory(options));
  const runSession = dependencies.runAgentSession || runAgentSession;
  const scenarioAssert = dependencies.assertScenario || assertScenario;
  const store = dependencies.store || new ArtifactStore({
    artifactDir,
    seedPinsPath,
    runId
  });
  const matrix = buildSessionMatrix();
  const results = [];
  const preflightResults = {};
  const seenSessionIds = new Set();
  let fixtureFactory;
  let primaryError;

  try {
    store.registerSensitiveValues?.([
      env.ANTHROPIC_API_KEY,
      env.CODEX_API_KEY,
      env.OPENAI_API_KEY,
      env.CURSOR_API_KEY,
      env.UCLUSION_DEV_CREDENTIALS,
      env.AWS_ACCESS_KEY_ID,
      env.AWS_SECRET_ACCESS_KEY,
      env.AWS_SESSION_TOKEN,
      env.AWS_SECURITY_TOKEN
    ].filter(Boolean));
    const sourcePackage = inspectSource(webUiRoot);
    store.setSourcePackage(sourcePackage);
    const preflightFailures = [];
    for (const client of CLIENTS) {
      try {
        const result = preflight(client, env);
        preflightResults[client] = result;
        store.setPreflight(client, result);
      } catch (error) {
        const failure = serializeError(error);
        preflightResults[client] = { status: 'failed', failure };
        store.setPreflight(client, preflightResults[client]);
        preflightFailures.push({ phase: 'preflight', client, ...failure });
      }
    }
    if (preflightFailures.length) {
      store.failPreflight({
        phase: 'preflight',
        name: 'ClientPreflightFailed',
        message: `${preflightFailures.length} client preflight(s) failed`,
        failures: preflightFailures
      });
      assert(store.assertPinsUnchanged(),
        'Preflight failure modified last-known-good pins');
      return { status: 'failed', results, preflight: preflightResults, store };
    }

    fixtureFactory = createFixtureFactory({ webUiRoot, runId, env });
    store.registerSensitiveValues?.(fixtureFactory.sensitiveValues?.() || []);
    await fixtureFactory.initialize();
    store.registerSensitiveValues?.(fixtureFactory.sensitiveValues?.() || []);
    for (const session of matrix) {
      let fixture;
      let sessionFailure;
      try {
        fixture = await fixtureFactory.create(session);
        store.registerSensitiveValues?.(fixture.sensitiveValues || []);
        const stateBefore = await fixture.snapshot();
        store.startSession(session, {
          market_id: fixture.marketId,
          target_short_code: fixture.targetShortCode,
          target_name: fixture.targetName,
          expected_cli_command: fixture.expectedCliCommand,
          staged_source: fixture.stagedSource
        });
        const agentResult = await runSession({
          session,
          fixture,
          tracePath: store.tracePath(session),
          timeoutMs,
          clientVersion: preflightResults[session.client].client_version,
          sendPoke: fixture.sendPoke,
          sourceEnv: env
        });
        assert.strictEqual(agentResult.processResult.timedOut, false,
          `${session.key} exceeded hard timeout ${timeoutMs}ms`);
        assert.notStrictEqual(agentResult.processResult.traceLimitExceeded, true,
          `${session.key} exceeded the hard JSONL trace byte limit`);
        assert.strictEqual(agentResult.processResult.spawnError, null,
          `${session.key} failed to spawn: ${agentResult.processResult.spawnError}`);
        assert.strictEqual(agentResult.processResult.exitCode, 0,
          `${session.key} exited ${agentResult.processResult.exitCode}: ` +
          agentResult.processResult.stderr);
        assert.deepStrictEqual(agentResult.processResult.callbackFailures, [],
          `${session.key} event callback failed`);
        assert.deepStrictEqual(agentResult.invalidJsonLines, [],
          `${session.key} emitted non-JSON stdout in stream-json mode`);
        const stateAfter = await fixture.snapshot();
        const primarySessionId = agentResult.modelRecord.primary_session_id;
        assert(!seenSessionIds.has(primarySessionId),
          `${session.key} reused prior agent session ${primarySessionId}`);
        seenSessionIds.add(primarySessionId);
        scenarioAssert({
          client: session.client,
          scenario: session.scenario,
          parsed: agentResult.parsed,
          expectedCommand: fixture.expectedCliCommand,
          targetShortCode: fixture.targetShortCode,
          targetName: fixture.targetName,
          stateBefore,
          stateAfter
        });
        const result = {
          status: 'passed',
          client: session.client,
          scenario: session.scenario,
          process: agentResult.processResult,
          state_before: stateBefore,
          state_after: stateAfter,
          tool_calls: agentResult.parsed.toolCalls,
          modelRecord: agentResult.modelRecord
        };
        results.push(result);
        store.finishSession(session, result, agentResult.modelRecord);
      } catch (error) {
        store.registerSensitiveValues?.(fixtureFactory.sensitiveValues?.() || []);
        sessionFailure = error;
        const failure = serializeError(error);
        const result = {
          status: 'failed',
          client: session.client,
          scenario: session.scenario,
          failure
        };
        results.push(result);
        store.finishSession(session, result);
      } finally {
        if (fixture) {
          try {
            await fixture.close();
          } catch (cleanupError) {
            const combined = sessionFailure
              ? new AggregateError(
                [sessionFailure, cleanupError],
                `${session.key} failed and its fixture cleanup also failed`
              )
              : cleanupError;
            const failure = serializeError(combined);
            const existingIndex = results.findIndex((entry) =>
              entry.client === session.client && entry.scenario === session.scenario);
            const failedResult = {
              status: 'failed',
              client: session.client,
              scenario: session.scenario,
              failure
            };
            if (existingIndex >= 0) {
              results[existingIndex] = failedResult;
            } else {
              results.push(failedResult);
            }
            store.finishSession(session, failedResult);
          }
        }
      }
    }

    // A factory-level retry covers markets whose setup failed before a fixture
    // object could be returned. It must complete before any success publication.
    await fixtureFactory.close?.();
    fixtureFactory = null;

    const allPassed = results.length === matrix.length &&
      results.every((result) => result.status === 'passed');
    if (allPassed) {
      const pins = pinDocument(runId, sourcePackage, preflightResults, results);
      store.validateTraces?.();
      store.finish('passed');
      store.assertNoSecrets?.();
      const ratcheted = ratchetIfAllPassed({
        results,
        expectedCount: matrix.length,
        targetPath: store.pinsPath,
        pins,
        baselineBytes: store.baselinePinBytes
      });
      assert.strictEqual(ratcheted, true, 'Every planned passing session must ratchet pins');
      return { status: 'passed', results, preflight: preflightResults, store };
    }

    assert(store.assertPinsUnchanged(),
      'A semantic/process failure modified last-known-good pins');
    store.validateTraces?.();
    store.finish('failed');
    return { status: 'failed', results, preflight: preflightResults, store };
  } catch (error) {
    primaryError = error;
    if (fixtureFactory) {
      store.registerSensitiveValues?.(fixtureFactory.sensitiveValues?.() || []);
      try {
        await fixtureFactory.close?.();
      } catch (cleanupError) {
        primaryError = new AggregateError(
          [primaryError, cleanupError],
          'Harness and factory-level fixture cleanup both failed'
        );
      }
    }
    try {
      store.validateTraces?.();
      store.failPreflight({ phase: 'harness', ...serializeError(primaryError) });
    } catch (publicationError) {
      primaryError = new AggregateError(
        [primaryError, publicationError],
        'Harness failure artifact publication also failed'
      );
    }
    const pinsUnchanged = store.assertPinsUnchanged();
    if (!pinsUnchanged) {
      primaryError = new AggregateError(
        [primaryError, new Error('Harness failure modified last-known-good pins')],
        'Harness failure and pin-integrity failure'
      );
    }
    return {
      status: 'failed',
      results,
      preflight: preflightResults,
      store,
      fatal: serializeError(primaryError)
    };
  }
}
