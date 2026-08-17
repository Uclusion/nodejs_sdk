import assert from 'assert';
import { randomUUID } from 'crypto';
import { ArtifactStore } from './artifacts.js';
import { preflightClient, runAgentSession } from './clientAdapters.js';
import { serializeError } from './errors.js';
import { assertCodexUsageWithinCeiling } from './semanticAssertions.js';
import { assertWorkClaimRace } from './workClaimsAssertions.js';
import { WorkClaimsDevFixture } from './workClaimsFixture.js';
import { buildWorkClaimsPlan } from './workClaimsScenarios.js';
import { inspectSourcePackage } from './sourcePackage.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function assertSuccessfulProcess(session, agentResult, timeoutMs) {
  const processResult = agentResult.processResult;
  assert.strictEqual(processResult.timedOut, false,
    `${session.key} exceeded hard timeout ${timeoutMs}ms`);
  assert.notStrictEqual(processResult.traceLimitExceeded, true,
    `${session.key} exceeded the hard JSONL trace byte limit`);
  assert.strictEqual(processResult.spawnError, null,
    `${session.key} failed to spawn: ${processResult.spawnError}`);
  assert.strictEqual(processResult.exitCode, 0,
    `${session.key} exited ${processResult.exitCode}: ${processResult.stderr}`);
  assert.deepStrictEqual(processResult.callbackFailures, [],
    `${session.key} event callback failed`);
  assert.deepStrictEqual(agentResult.invalidJsonLines, [],
    `${session.key} emitted non-JSON stdout in JSON mode`);
}

function racerFailureResult({ planned, error, agentResult, stateBefore, stateAfter }) {
  const result = {
    status: 'failed',
    client: 'codex',
    scenario: planned.id,
    phase: planned.phase,
    failure: serializeError(error)
  };
  if (agentResult?.processResult) {
    result.process = agentResult.processResult;
  }
  if (stateBefore !== undefined) {
    result.state_before = stateBefore;
  }
  if (stateAfter !== undefined) {
    result.state_after = stateAfter;
  }
  if (agentResult?.parsed?.toolCalls) {
    result.tool_calls = agentResult.parsed.toolCalls;
  }
  if (agentResult?.invalidJsonLines) {
    result.invalid_json_lines = agentResult.invalidJsonLines;
  }
  if (agentResult?.modelRecord) {
    result.modelRecord = agentResult.modelRecord;
  }
  return result;
}

export async function executeWorkClaimsHarness({
  artifactDir,
  seedPinsPath,
  webUiRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runId = randomUUID(),
  env = process.env,
  sessions,
  catalog = 'work-claims',
  reportProgress = () => {},
  dependencies = {}
}) {
  const inspectSource = dependencies.inspectSourcePackage || inspectSourcePackage;
  const preflight = dependencies.preflightClient || preflightClient;
  const createFixture = dependencies.createFixture ||
    ((options) => new WorkClaimsDevFixture(options));
  const runSession = dependencies.runAgentSession || runAgentSession;
  const plan = (sessions || buildWorkClaimsPlan()).map((session) => ({ ...session }));
  assert.strictEqual(plan.length, 2,
    'Work claims harness races exactly two concurrent live processes');
  const store = dependencies.store || new ArtifactStore({
    artifactDir,
    seedPinsPath,
    runId,
    sessions: plan,
    catalog
  });
  const results = [];
  const preflightResults = {};
  let fixture;
  let fatalError;

  try {
    reportProgress('Preparing work-claims catalog with two concurrent Codex racers');
    store.registerSensitiveValues?.([
      env.CODEX_API_KEY,
      env.OPENAI_API_KEY,
      env.UCLUSION_DEV_CREDENTIALS,
      env.AWS_ACCESS_KEY_ID,
      env.AWS_SECRET_ACCESS_KEY,
      env.AWS_SESSION_TOKEN,
      env.AWS_SECURITY_TOKEN
    ].filter(Boolean));
    assert(
      env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() ||
        env.TEST_AGENT_DEV_USE_LOCAL_AUTH === '1',
      'Work claims Codex requires CODEX_API_KEY/OPENAI_API_KEY or explicit local-auth staging'
    );
    const sourcePackage = inspectSource(webUiRoot);
    store.setSourcePackage(sourcePackage);
    try {
      const result = preflight('codex', env);
      preflightResults.codex = result;
      store.setPreflight('codex', result);
    } catch (error) {
      const failure = serializeError(error);
      preflightResults.codex = { status: 'failed', failure };
      store.setPreflight('codex', preflightResults.codex);
      store.failPreflight({ phase: 'preflight', client: 'codex', ...failure });
      assert(store.assertPinsUnchanged(),
        'Work claims preflight failure modified last-known-good pins');
      return { status: 'failed', results, preflight: preflightResults, store };
    }

    fixture = createFixture({ webUiRoot, runId, env });
    store.registerSensitiveValues?.(fixture.sensitiveValues?.() || []);
    reportProgress('Creating one fresh marked DEV market with auto-take and the contested job');
    await fixture.initialize();
    store.registerSensitiveValues?.(fixture.sensitiveValues?.() || []);

    const racerFixtures = [];
    for (const planned of plan) {
      const racerFixture = await fixture.prepareRacer(planned);
      store.registerSensitiveValues?.([
        ...(fixture.sensitiveValues?.() || []),
        ...(racerFixture.sensitiveValues || [])
      ]);
      racerFixtures.push(racerFixture);
    }
    const stateBefore = await fixture.snapshotRace();
    for (const [index, planned] of plan.entries()) {
      store.startSession(planned, {
        market_id: racerFixtures[index].marketId,
        contested_code: fixture.targets().contestedJobCode,
        staged_source: racerFixtures[index].stagedSource
      });
    }

    // The race itself: both fully isolated sessions launch together and the
    // grading decides which one won afterward.
    reportProgress('Launching both Codex racers concurrently against the one contested job');
    const settled = await Promise.allSettled(plan.map((planned, index) =>
      runSession({
        session: planned,
        fixture: racerFixtures[index],
        tracePath: store.tracePath(planned),
        timeoutMs,
        clientVersion: preflightResults.codex.client_version,
        sourceEnv: env
      })));
    const stateAfter = await fixture.snapshotRace();

    let raceFailure = null;
    const sessionRecords = [];
    for (const [index, planned] of plan.entries()) {
      const outcome = settled[index];
      if (outcome.status === 'rejected') {
        const error = outcome.reason;
        raceFailure ||= error;
        results.push(racerFailureResult({
          planned,
          error,
          agentResult: error?.agentResult,
          stateBefore,
          stateAfter
        }));
        store.finishSession(planned, results[results.length - 1],
          error?.agentResult?.modelRecord || null);
        continue;
      }
      sessionRecords.push({ session: planned, agentResult: outcome.value });
    }

    if (!raceFailure) {
      try {
        const sessionIds = new Set();
        for (const { session, agentResult } of sessionRecords) {
          assertSuccessfulProcess(session, agentResult, timeoutMs);
          assertCodexUsageWithinCeiling(agentResult.modelRecord.reported_usage);
          const primarySessionId = agentResult.modelRecord.primary_session_id;
          assert(primarySessionId,
            `${session.key} did not expose a fresh Codex session id`);
          assert(!sessionIds.has(primarySessionId),
            `${session.key} reused another racer's Codex session ${primarySessionId}`);
          sessionIds.add(primarySessionId);
        }
        fixture.assertRace(stateBefore, stateAfter);
        const verdict = assertWorkClaimRace({
          contestedCode: fixture.targets().contestedJobCode,
          sessions: sessionRecords.map(({ session, agentResult }) => ({
            session,
            parsed: agentResult.parsed
          }))
        });
        reportProgress(
          `Race graded: ${verdict.winner} won the claim, ${verdict.loser} was denied`
        );
        for (const { session, agentResult } of sessionRecords) {
          const sessionResult = {
            status: 'passed',
            client: 'codex',
            scenario: session.id,
            phase: session.phase,
            race: verdict,
            reported_tokens: assertCodexUsageWithinCeiling(
              agentResult.modelRecord.reported_usage
            ),
            process: agentResult.processResult,
            state_before: stateBefore,
            state_after: stateAfter,
            tool_calls: agentResult.parsed.toolCalls,
            modelRecord: agentResult.modelRecord
          };
          results.push(sessionResult);
          store.finishSession(session, sessionResult, agentResult.modelRecord);
        }
      } catch (error) {
        raceFailure = error;
        for (const { session, agentResult } of sessionRecords) {
          const sessionResult = racerFailureResult({
            planned: session,
            error,
            agentResult,
            stateBefore,
            stateAfter
          });
          results.push(sessionResult);
          store.finishSession(session, sessionResult, agentResult.modelRecord || null);
        }
      }
    }

    for (const racerFixture of racerFixtures) {
      await racerFixture.close();
    }
    await fixture.close();
    fixture = null;
    assert(store.assertPinsUnchanged(),
      'Work claims catalog modified last-known-good trigger pins');
    store.validateTraces?.();
    const passed = !raceFailure && results.length === plan.length &&
      results.every((result) => result.status === 'passed');
    store.finish(passed ? 'passed' : 'failed');
    return {
      status: passed ? 'passed' : 'failed',
      results,
      preflight: preflightResults,
      store
    };
  } catch (error) {
    fatalError = error;
    const finalSensitiveValues = fixture?.sensitiveValues?.() || [];
    if (fixture) {
      try {
        await fixture.close();
      } catch (cleanupError) {
        fatalError = new AggregateError(
          [fatalError, cleanupError],
          'Work claims harness and outer cleanup both failed'
        );
      }
      fixture = null;
    }
    try {
      store.registerSensitiveValues?.(finalSensitiveValues, { flush: false });
      store.validateTraces?.();
      store.failPreflight({ phase: 'work-claims-harness', ...serializeError(fatalError) });
    } catch (publicationError) {
      fatalError = new AggregateError(
        [fatalError, publicationError],
        'Work claims failure artifact publication also failed'
      );
    }
    if (!store.assertPinsUnchanged()) {
      fatalError = new AggregateError(
        [fatalError, new Error('Work claims harness modified last-known-good pins')],
        'Work claims harness and pin-integrity failure'
      );
    }
    return {
      status: 'failed',
      results,
      preflight: preflightResults,
      store,
      fatal: serializeError(fatalError)
    };
  }
}
