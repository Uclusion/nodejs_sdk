import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ArtifactStore } from './artifacts.js';
import { preflightClient, runAgentSession } from './clientAdapters.js';
import { serializeError } from './errors.js';
import {
  assertCodexUsageWithinCeiling,
  assertSkillLoadedBeforeSemanticMcp
} from './semanticAssertions.js';
import { QuestionGateDevFixture } from './questionGateFixture.js';
import { buildQuestionGatePlan } from './questionGateScenarios.js';
import { inspectSourcePackage } from './sourcePackage.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// The full gate contract (checklist walk, disclosure note, question batch
// with options and votes) legitimately spends more than the semantic
// catalog's baseline; a compliant session measured 541k.
const QUESTION_GATE_TOKEN_CEILING = 700000;

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

export async function executeQuestionGateHarness({
  artifactDir,
  marketCleanup,
  seedPinsPath,
  webUiRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runId = randomUUID(),
  env = process.env,
  sessions,
  catalog = 'question-gate',
  reportProgress = () => {},
  dependencies = {}
}) {
  const inspectSource = dependencies.inspectSourcePackage || inspectSourcePackage;
  const preflight = dependencies.preflightClient || preflightClient;
  const createFixture = dependencies.createFixture ||
    ((options) => new QuestionGateDevFixture(options));
  const runSession = dependencies.runAgentSession || runAgentSession;
  const plan = (sessions || buildQuestionGatePlan()).map((session) => ({ ...session }));
  assert(plan.length > 0, 'Question gate harness requires at least one planned live process');
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
      `Preparing question-gate catalog with ${plan.length} serial Codex ` +
      `${plan.length === 1 ? 'process' : 'processes'}`
    );
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
      'Question gate Codex requires CODEX_API_KEY/OPENAI_API_KEY or explicit local-auth staging'
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
        'Question gate preflight failure modified last-known-good pins');
      return { status: 'failed', results, preflight: preflightResults, store };
    }

    fixture = createFixture({ webUiRoot, runId, env, marketCleanup });
    store.registerSensitiveValues?.(fixture.sensitiveValues?.() || []);
    reportProgress('Creating one fresh marked DEV market with auto-take');
    await fixture.initialize();
    store.registerSensitiveValues?.(fixture.sensitiveValues?.() || []);

    for (const [phaseIndex, planned] of plan.entries()) {
      reportProgress(
        `Starting live tier ${phaseIndex + 1}/${plan.length}: ${planned.description}`
      );
      let sessionFixture;
      let sessionFailure;
      let sessionResult;
      let agentResult;
      let stateBefore;
      let stateAfter;
      try {
        sessionFixture = await fixture.preparePhase(planned);
        store.registerSensitiveValues?.([
          ...(fixture.sensitiveValues?.() || []),
          ...(sessionFixture.sensitiveValues || [])
        ]);
        stateBefore = await fixture.snapshotGate(planned.phase);
        store.startSession(planned, {
          market_id: sessionFixture.marketId,
          planted_job_code: fixture.targets()[planned.phase],
          staged_source: sessionFixture.stagedSource
        });
        agentResult = await runSession({
          session: planned,
          fixture: sessionFixture,
          tracePath: store.tracePath(planned),
          timeoutMs,
          clientVersion: preflightResults.codex.client_version,
          sourceEnv: env
        });
        assertSuccessfulProcess(planned, agentResult, timeoutMs);
        const reportedTokens = assertCodexUsageWithinCeiling(
          agentResult.modelRecord.reported_usage,
          QUESTION_GATE_TOKEN_CEILING
        );
        // A session that skims the skill never sees the gate at all, which is
        // a delivery failure, not a wording verdict: one live session read
        // SKILL.md from line 241 and bypassed every instruction under test.
        const expectedSkillPath = path.join(
          sessionFixture.stagedSource.skillTarget,
          'SKILL.md'
        );
        assertSkillLoadedBeforeSemanticMcp(agentResult.parsed, {
          expectedSkillPath,
          expectedSkillContent: fs.readFileSync(expectedSkillPath, 'utf8')
        });
        stateAfter = await fixture.snapshotUntilSettled(planned.phase);
        await fixture.assertGate(planned.phase, stateAfter);
        const primarySessionId = agentResult.modelRecord.primary_session_id;
        assert(primarySessionId,
          `${planned.key} did not expose a fresh Codex session id`);
        assert(!seenSessionIds.has(primarySessionId),
          `${planned.key} reused a prior Codex session ${primarySessionId}`);
        seenSessionIds.add(primarySessionId);
        reportProgress(
          `Tier ${phaseIndex + 1} graded: disclosure present, all decisions surfaced, no work done`
        );
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
        if (stateAfter === undefined) {
          try {
            stateAfter = await fixture.snapshotGate(planned.phase);
          } catch (_snapshotError) {
            // The original failure is the actionable one.
          }
        }
        sessionFailure = error;
        sessionResult = {
          status: 'failed',
          client: 'codex',
          scenario: planned.id,
          phase: planned.phase,
          failure: serializeError(error),
          process: agentResult?.processResult,
          state_before: stateBefore,
          state_after: stateAfter,
          tool_calls: agentResult?.parsed?.toolCalls,
          modelRecord: agentResult?.modelRecord
        };
      } finally {
        if (sessionFixture) {
          try {
            await sessionFixture.close();
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
      store.finishSession(planned, sessionResult, agentResult?.modelRecord || null);
      reportProgress(
        `${sessionResult.status === 'passed' ? 'Passed' : 'Failed'} live tier ` +
        `${phaseIndex + 1}/${plan.length}: ${planned.description}`
      );
      // Paid invocations have no whole-session retry; a failed tier aborts the
      // remaining catalog rather than consuming more model calls.
      if (sessionFailure) {
        break;
      }
    }

    await fixture.close();
    fixture = null;
    assert(store.assertPinsUnchanged(),
      'Question gate catalog modified last-known-good trigger pins');
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
          'Question gate harness and outer cleanup both failed'
        );
      }
      fixture = null;
    }
    try {
      store.registerSensitiveValues?.(finalSensitiveValues, { flush: false });
      store.validateTraces?.();
      store.failPreflight({ phase: 'question-gate-harness', ...serializeError(fatalError) });
    } catch (publicationError) {
      fatalError = new AggregateError(
        [fatalError, publicationError],
        'Question gate failure artifact publication also failed'
      );
    }
    if (!store.assertPinsUnchanged()) {
      fatalError = new AggregateError(
        [fatalError, new Error('Question gate harness modified last-known-good pins')],
        'Question gate harness and pin-integrity failure'
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
