import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import AWS from 'aws-sdk';
import { ArtifactStore } from './artifacts.js';
import { preflightClient } from './clientAdapters.js';
import { startCodexTelemetryReceiver } from './codexTelemetry.js';
import { serializeError } from './errors.js';
import { inspectSourcePackage } from './sourcePackage.js';
import { NativeCodexSession } from './nativeCodexSession.js';
import { DesignHandoffDevFixture } from './designHandoffFixture.js';
import { buildDesignHandoffPlan, designHandoffPrompts } from './designHandoffScenarios.js';

export async function executeDesignHandoffHarness({ artifactDir, seedPinsPath, webUiRoot,
  marketCleanup, env = process.env, runId = randomUUID(), reportProgress = () => {} }) {
  const [session] = buildDesignHandoffPlan();
  const store = new ArtifactStore({ artifactDir, seedPinsPath, runId,
    sessions: [session], catalog: 'design-handoff' });
  store.registerSensitiveValues([
    env.CODEX_API_KEY, env.OPENAI_API_KEY, env.UCLUSION_DEV_CREDENTIALS,
    env.UCLUSION_DEV_ADVISORY_CREDENTIALS, env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN
  ].filter(Boolean));
  const checkpoints = [];
  let fixture;
  let local;
  let native;
  let telemetry;
  let failure;
  let modelRecord;
  let state;
  let cleanupReceipt;
  const checkpoint = async (id, turnId, prompt) => {
    const threads = await native.histories();
    state = await fixture.snapshotSemantic();
    if (native.failure) throw native.failure;
    checkpoints.push({ id, turn_id: turnId, prompt, state,
      thread_ids: Object.keys(threads), reported_usage: structuredClone(Object.fromEntries(native.usage)) });
    store.sanitizeTrace(store.tracePath(session));
    Object.assign(store.manifest.sessions[session.key], { checkpoints,
      root_thread_id: native.rootId, status: 'awaiting-analysis' });
    store.flush();
    reportProgress(`Evidence checkpoint saved: ${id}. Artifacts: ${artifactDir}`);
    return threads;
  };
  const awaitContinuation = async (checkpointId) => {
    // This control file is outside the participant workspace. The analyst can
    // inspect the native evidence before permitting the next fixture input.
    const controlPath = path.join(artifactDir, `${checkpointId}-${native.rootId}-continue.json`);
    reportProgress(`Awaiting analyst control: ${controlPath} ({"continue":true} or {"continue":false})`);
    while (!fs.existsSync(controlPath)) {
      if (native.failure) throw native.failure;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const decision = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    assert.strictEqual(typeof decision.continue, 'boolean', 'Analyst continuation must be explicit');
    native.record('analyst-continuation', { checkpoint: checkpointId, ...decision });
    return decision.continue;
  };
  try {
    assert(env.CODEX_API_KEY || env.OPENAI_API_KEY || env.TEST_AGENT_DEV_USE_LOCAL_AUTH === '1',
      'Live handoff requires a provider key or explicit local-auth staging');
    store.setSourcePackage(inspectSourcePackage(webUiRoot));
    const preflight = preflightClient('codex', env);
    // Check cleanup authorization without invoking deletion or creating a market.
    const cleanup = await new AWS.Lambda({ region: 'us-west-2', maxRetries: 0,
      httpOptions: { timeout: 30000 } }).invoke({
      FunctionName: 'uclusion-markets-dev-markets_delete', InvocationType: 'DryRun'
    }).promise();
    assert.strictEqual(cleanup.StatusCode, 204, 'DEV guarded cleanup dry run failed');
    store.setPreflight('codex', { ...preflight, cleanup_dry_run: 'passed' });
    reportProgress('Creating the isolated DEV handoff fixture; no model turn has started');
    fixture = new DesignHandoffDevFixture({ webUiRoot, runId, env, marketCleanup });
    await fixture.initialize();
    local = fixture.prepareWorkspace(session);
    store.registerSensitiveValues(fixture.sensitiveValues());
    store.startSession(session, { market_id: fixture.marketId, staged_source: local.stagedSource,
      limits: { timeout_ms: 1200000, aggregate_reported_tokens: 4000000, concurrent_threads: 3 } });
    telemetry = await startCodexTelemetryReceiver({ multipleConversations: true });
    native = new NativeCodexSession({ fixture: local, tracePath: store.tracePath(session), env,
      telemetryEndpoint: telemetry.endpoint });
    await native.start();
    const config = native.config.config;
    assert.strictEqual(config.features?.multi_agent_v2?.max_concurrent_threads_per_session, 3,
      'Native client did not accept its finite concurrency limit');
    assert.strictEqual(config.features?.multi_agent_v2?.enabled, true, 'Native collaboration is unavailable');
    const prompts = designHandoffPrompts(fixture.jobCode, fixture.tasks[0].code);
    reportProgress('Starting the real Codex design-handoff turn (one ordinary client, 20 minutes, 4M aggregate tokens)');
    const designTurn = await native.turn(prompts[0]);
    let finalThreads = await checkpoint('design-handoff-awaiting-stage', designTurn, prompts[0]);
    if (await awaitContinuation('design-handoff-awaiting-stage')) {
      reportProgress('Continuing the same session after the fixture human moves its job to Doable');
      const stageReceipt = await fixture.allowImplementation();
      native.record('fixture-stage-change', { job: fixture.jobCode, stage: stageReceipt.stage });
      const implementationTurn = await native.turn(prompts[1]);
      finalThreads = await checkpoint('design-handoff-continue', implementationTurn, prompts[1]);
      if (await awaitContinuation('design-handoff-continue')) {
        const reuseTurn = await native.turn(prompts[2]);
        finalThreads = await checkpoint('design-handoff-reuse', reuseTurn, prompts[2]);
      }
    }
    for (const [relative, fingerprint] of Object.entries(local.stagedSource.skill)) {
      const bytes = fs.readFileSync(path.join(local.stagedSource.skillTarget, relative));
      assert.strictEqual(createHash('sha256').update(bytes).digest('hex'), fingerprint.sha256,
        `Participant modified staged instructions: ${relative}`);
    }
    const models = {};
    for (const thread of Object.values(finalThreads)) {
      assert(native.usage.has(thread.id), `Missing final native usage: ${thread.id}`);
      models[thread.id] = { parent_thread_id: thread.parentThreadId,
        model: await telemetry.resolvedModel(thread.id), reasoning_effort: thread.reasoningEffort,
        reported_usage: native.usage.get(thread.id) };
    }
    modelRecord = { client: 'codex', client_version: preflight.client_version,
      primary_session_id: native.rootId, provider: finalThreads[native.rootId].modelProvider,
      threads: models, reported_tokens: native.reportedTokens() };
  } catch (error) {
    failure = error;
    const captures = await Promise.allSettled([
      native?.rootId ? native.histories() : Promise.resolve(),
      fixture?.jobCode ? fixture.snapshotSemantic() : Promise.resolve()
    ]);
    if (captures[1].status === 'fulfilled') state = captures[1].value;
    for (const capture of captures) {
      if (capture.status === 'rejected') {
        failure = new AggregateError([failure, capture.reason], 'Live run and failure-evidence capture failed');
      }
    }
  } finally {
    try { native?.scanUsage(); } catch (error) { failure ||= error; }
    failure ||= native?.failure;
    try { await native?.close(); } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Live run and native cleanup failed') : error;
    }
    failure ||= native?.failure;
    try { await telemetry?.close(); } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Live run and telemetry cleanup failed') : error;
    }
    const finalSecrets = fixture?.sensitiveValues() || [];
    const cleanupMarket = fixture?.marketId;
    try {
      await fixture?.close();
      cleanupReceipt = { market_id: cleanupMarket, status: 'completed' };
    } catch (error) {
      cleanupReceipt = { market_id: cleanupMarket, status: 'failed', failure: serializeError(error) };
      failure = failure ? new AggregateError([failure, error], 'Live run and cleanup failed') : error;
    }
    store.registerSensitiveValues(finalSecrets, { flush: false });
    store.validateTraces();
  }
  const result = { status: failure ? 'failed' : 'recorded', workflow_verdict: 'pending analyst review',
    checkpoints, state_after: structuredClone(state), cleanup: cleanupReceipt,
    root_thread_id: native?.rootId,
    reported_usage: native ? structuredClone(Object.fromEntries(native.usage)) : {},
    reported_tokens: native?.reportedTokens(), stderr: native?.stderr,
    ...(failure ? { failure: serializeError(failure) } : {}) };
  store.finishSession(session, result, modelRecord);
  assert(store.assertPinsUnchanged(), 'Handoff catalog modified unrelated last-known-good pins');
  store.finish(result.status);
  return { status: result.status, results: [result], store };
}
