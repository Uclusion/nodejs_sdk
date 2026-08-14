import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ArtifactStore } from './artifacts.js';
import { preflightClient, runAgentSession } from './clientAdapters.js';
import { serializeError } from './errors.js';
import {
  assertCodexUsageWithinCeiling,
  assertSemanticTranscript
} from './semanticAssertions.js';
import { SemanticDevFixture } from './semanticFixture.js';
import { buildSemanticPlan, semanticPrompt } from './semanticScenarios.js';
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

function semanticFailureResult({ planned, error, agentResult, stateBefore, stateAfter }) {
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

export async function executeSemanticHarness({
  artifactDir,
  seedPinsPath,
  webUiRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runId = randomUUID(),
  env = process.env,
  sessions,
  catalog = 'semantic',
  reportProgress = () => {},
  dependencies = {}
}) {
  const inspectSource = dependencies.inspectSourcePackage || inspectSourcePackage;
  const preflight = dependencies.preflightClient || preflightClient;
  const createFixture = dependencies.createFixture ||
    ((options) => new SemanticDevFixture(options));
  const runSession = dependencies.runAgentSession || runAgentSession;
  const plan = (sessions || buildSemanticPlan()).map((session) => ({ ...session }));
  assert(plan.length > 0, 'Semantic harness requires at least one planned live process');
  const store = dependencies.store || new ArtifactStore({
    artifactDir,
    seedPinsPath,
    runId,
    sessions: plan,
    catalog
  });
  const results = [];
  const preflightResults = {};
  const seenSessionIds = new Set();
  let fixture;
  let fatalError;

  try {
    reportProgress(
      `Preparing ${catalog} catalog with ${plan.length} fresh Codex ` +
      `${plan.length === 1 ? 'process' : 'processes'}`
    );
    store.registerSensitiveValues?.([
      env.CODEX_API_KEY,
      env.OPENAI_API_KEY,
      env.UCLUSION_DEV_CREDENTIALS,
      env.UCLUSION_DEV_ADVISORY_CREDENTIALS,
      env.AWS_ACCESS_KEY_ID,
      env.AWS_SECRET_ACCESS_KEY,
      env.AWS_SESSION_TOKEN,
      env.AWS_SECURITY_TOKEN
    ].filter(Boolean));
    assert(
      env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() ||
        env.TEST_AGENT_DEV_USE_LOCAL_AUTH === '1',
      'Semantic Codex requires CODEX_API_KEY/OPENAI_API_KEY or explicit local-auth staging'
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
        'Semantic preflight failure modified last-known-good pins');
      return { status: 'failed', results, preflight: preflightResults, store };
    }

    fixture = createFixture({ webUiRoot, runId, env });
    store.registerSensitiveValues?.(fixture.sensitiveValues?.() || []);
    reportProgress('Creating one fresh marked DEV market and isolated semantic fixture');
    await fixture.initialize();
    store.registerSensitiveValues?.(fixture.sensitiveValues?.() || []);
    reportProgress('Semantic fixture is ready; starting the selected live process plan');

    for (const [phaseIndex, planned] of plan.entries()) {
      reportProgress(
        `Starting live phase ${phaseIndex + 1}/${plan.length}: ${planned.description}`
      );
      let phaseFixture;
      let sessionFailure;
      let runtimeSession = planned;
      let agentResult;
      let stateBefore;
      let stateAfter;
      let sessionResult;
      let expectedSkillPath;
      let expectedSkillContent;
      let agentInvocationStarted = false;
      try {
        phaseFixture = await fixture.preparePhase(planned);
        store.registerSensitiveValues?.([
          ...(fixture.sensitiveValues?.() || []),
          ...(phaseFixture.sensitiveValues || [])
        ]);
        runtimeSession = {
          ...planned,
          prompt: semanticPrompt(planned, fixture.targets())
        };
        expectedSkillPath = path.join(
          phaseFixture.stagedSource.skillTarget,
          'SKILL.md'
        );
        expectedSkillContent = fs.readFileSync(expectedSkillPath, 'utf8');
        stateBefore = await phaseFixture.snapshot();
        store.startSession(runtimeSession, {
          market_id: phaseFixture.marketId,
          expected_event: phaseFixture.expectedEvent,
          staged_source: phaseFixture.stagedSource
        });
        agentInvocationStarted = true;
        agentResult = await runSession({
          session: runtimeSession,
          fixture: phaseFixture,
          tracePath: store.tracePath(runtimeSession),
          timeoutMs,
          clientVersion: preflightResults.codex.client_version,
          sourceEnv: env
        });
        assertSuccessfulProcess(runtimeSession, agentResult, timeoutMs);
        const reportedTokens = assertCodexUsageWithinCeiling(
          agentResult.modelRecord.reported_usage
        );
        try {
          stateAfter = fixture.snapshotAfterPhase
            ? await fixture.snapshotAfterPhase(planned.phase)
            : await fixture.snapshotSemantic();
        } catch (stateError) {
          // Preserve the latest durable state even when convergence itself is
          // the failing semantic assertion.
          try {
            stateAfter = await fixture.snapshotSemantic();
          } catch (_snapshotError) {
            // The original convergence error is the actionable failure.
          }
          throw stateError;
        }
        fixture.assertPhase(planned.phase, stateBefore, stateAfter);
        assertSemanticTranscript({
          phase: planned.phase,
          parsed: agentResult.parsed,
          targets: {
            ...fixture.targets(),
            bugJobCode: stateAfter.bug?.job_code,
            bugQuestionCode: stateAfter.bug?.question_code,
            bugOptionCodes: stateAfter.bug?.option_codes
          },
          expectedSkillPath,
          expectedSkillContent
        });
        const primarySessionId = agentResult.modelRecord.primary_session_id;
        assert(primarySessionId,
          `${runtimeSession.key} did not expose a fresh Codex session id`);
        assert(!seenSessionIds.has(primarySessionId),
          `${runtimeSession.key} reused prior Codex session ${primarySessionId}`);
        seenSessionIds.add(primarySessionId);
        sessionResult = {
          status: 'passed',
          client: 'codex',
          scenario: planned.id,
          phase: planned.phase,
          reported_tokens: reportedTokens,
          process: agentResult.processResult,
          state_before: stateBefore,
          state_after: stateAfter,
          tool_calls: agentResult.parsed.toolCalls,
          modelRecord: agentResult.modelRecord
        };
      } catch (error) {
        agentResult ||= error?.agentResult;
        if (agentInvocationStarted && stateAfter === undefined) {
          try {
            stateAfter = await fixture.snapshotSemantic();
          } catch (_snapshotError) {
            // Preserve the process/parser failure even if diagnostics cannot
            // read the latest external state.
          }
        }
        sessionFailure = error;
        sessionResult = semanticFailureResult({
          planned,
          error,
          agentResult,
          stateBefore,
          stateAfter
        });
      } finally {
        if (phaseFixture) {
          try {
            await phaseFixture.close();
          } catch (cleanupError) {
            const combined = sessionFailure
              ? new AggregateError(
                [sessionFailure, cleanupError],
                `${planned.key} and its local cleanup both failed`
              )
              : cleanupError;
            sessionResult = {
              ...(sessionResult || {}),
              status: 'failed',
              client: 'codex',
              scenario: planned.id,
              phase: planned.phase,
              failure: serializeError(combined)
            };
            sessionFailure = combined;
          }
        }
      }
      results.push(sessionResult);
      store.finishSession(runtimeSession, sessionResult, agentResult?.modelRecord || null);
      reportProgress(
        `${sessionResult.status === 'passed' ? 'Passed' : 'Failed'} live phase ` +
        `${phaseIndex + 1}/${plan.length}: ${planned.description}`
      );
      // Paid semantic invocations have no whole-session retry, and a failure
      // aborts the remaining catalog rather than consuming more model calls.
      if (sessionFailure) {
        break;
      }
    }

    await fixture.close();
    fixture = null;
    assert(store.assertPinsUnchanged(),
      'Semantic catalog modified last-known-good trigger pins');
    store.validateTraces?.();
    const passed = results.length === plan.length &&
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
          'Semantic harness and outer cleanup both failed'
        );
      }
      fixture = null;
    }
    try {
      // Cleanup must never depend on artifact publication. Stage any secrets
      // learned during a failed initialization without flushing against an
      // unsanitized trace, then redact/validate before publishing the failure.
      store.registerSensitiveValues?.(
        finalSensitiveValues,
        { flush: false }
      );
      store.validateTraces?.();
      store.failPreflight({ phase: 'semantic-harness', ...serializeError(fatalError) });
    } catch (publicationError) {
      fatalError = new AggregateError(
        [fatalError, publicationError],
        'Semantic failure artifact publication also failed'
      );
    }
    if (!store.assertPinsUnchanged()) {
      fatalError = new AggregateError(
        [fatalError, new Error('Semantic harness modified last-known-good pins')],
        'Semantic harness and pin-integrity failure'
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
