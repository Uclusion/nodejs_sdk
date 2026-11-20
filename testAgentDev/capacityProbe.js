#!/usr/bin/env node
// A fixed useful verification batch at several real native helper counts.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { mcpCall } from '../tests/commonTestFunctions.js';
import { SemanticDevFixture } from './semanticFixture.js';
import { executeSemanticHarness } from './semanticHarness.js';
import { NativeCodexSession } from './nativeCodexSession.js';
import { startCodexTelemetryReceiver } from './codexTelemetry.js';
import { parseAgentTrace } from './trace.js';
import { questionClosureNativeEvents } from './questionClosureNativeSession.js';
import { deleteIntegrationTestMarket } from './devFixture.js';
import { createPendingMarketCleanup, runAfterPendingMarketCleanup } from './pendingMarketCleanup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_PACKETS = JSON.parse(fs.readFileSync(path.join(HERE, 'capacityPackets.json')));
const PACKETS = ['a', 'b'].flatMap((replica) => BASE_PACKETS.map((packet) =>
  ({ ...packet, base_id: packet.id, replica, id: `${packet.id}-${replica}` })));
const MODEL = 'gpt-6.2-sol';
const EFFORT = 'low';
const TIMEOUT_MS = 600000;
const TOKEN_CEILING = 4000000;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fingerprintTree(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).sort()
    .filter((name) => !name.split(path.sep).includes('__pycache__'))
    .filter((name) => fs.statSync(path.join(root, name)).isFile())
    .map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]));
}

export function packetEvidence(packet, source) {
  const lines = fs.readFileSync(path.join(source, packet.source), 'utf8').split('\n');
  const selected = new Set();
  for (const anchor of packet.anchors.slice(0, 2)) {
    const at = lines.findIndex((line) => line.includes(anchor));
    if (at < 0) continue;
    for (let i = Math.max(0, at - 4); i < Math.min(lines.length, at + 60); i++) selected.add(i);
  }
  let text = `Contract: ${packet.contract}\n\nSource excerpts (${packet.source}):\n` +
    [...selected].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`).join('\n');
  for (const test of packet.tests.slice(0, 2)) {
    const parts = test.split('.');
    const file = `${parts.slice(0, 4).join('/')}.py`;
    const testLines = fs.readFileSync(path.join(source, file), 'utf8').split('\n');
    const classStart = parts[4] ? testLines.findIndex((line) => line.startsWith(`class ${parts[4]}(`)) : 0;
    assert(classStart >= 0, `Packet class missing: ${test}`);
    const start = testLines.findIndex((line, i) => i >= classStart && line.includes('def test_'));
    text += `\n\nTest excerpt (${file}):\n` + testLines.slice(start, start + 40)
      .map((line, i) => `${start + i + 1}: ${line}`).join('\n');
  }
  // The same frozen excerpt is used in every case; participants may inspect an
  // additional focused 100 lines if needed, but do not reread whole modules.
  return `${text.slice(0, 14000)}\n`;
}

export function balancedGroups(packets, baseline) {
  let groups = packets.map((packet) => ({ ids: [packet.id],
    weight: baseline.find((row) => row.packet === (packet.base_id || packet.id)).wall_seconds + packet.reading_bytes / 2000 }));
  const levels = { 8: groups.map((group) => group.ids) };
  for (const count of [4, 2, 1]) {
    groups.sort((a, b) => b.weight - a.weight || a.ids[0].localeCompare(b.ids[0]));
    const joined = [];
    while (groups.length) {
      const high = groups.shift();
      const low = groups.pop();
      joined.push({ ids: [...high.ids, ...low.ids], weight: high.weight + low.weight });
    }
    groups = joined;
    levels[count] = groups.map((group) => group.ids);
  }
  return levels;
}

class CapacityFixture extends SemanticDevFixture {
  async initializeScenario() {
    this.bugs = {};
    for (const packet of PACKETS) {
      const marker = `Capacity verification ${this.marker} ${packet.id}`;
      await mcpCall(this.primaryConfiguration, this.uclusionToken, 'add_bug', {
        bug: `${marker}. Read-only verification assignment: ${packet.contract} ` +
          'Read the bounded local evidence, run the assigned existing local tests once, and report findings. ' +
          'No source edits, configuration changes, remote writes, deployment, or resolution are requested.',
        severity: 'YELLOW'
      });
      this.bugs[packet.id] = await this.findComment(marker);
      assert(this.bugs[packet.id]?.ticket_code?.startsWith('B-'));
    }
  }

  targets() { return { packetCodes: Object.fromEntries(PACKETS.map((p) => [p.id, this.bugs[p.id].ticket_code])),
    packetGroups: this.local?.capacity?.study.groups }; }

  preparePhase(session) {
    this.local = this.createPhaseFixture(session, `capacity ${session.helperCount}`);
    const local = this.local;
    const source = path.join(local.workspace, 'source');
    fs.cpSync(this.webUiRoot, source, { recursive: true,
      filter: (name) => !name.split(path.sep).includes('__pycache__') });
    fs.mkdirSync(path.join(local.workspace, 'results'));
    fs.copyFileSync(path.join(HERE, 'capacityPacketRunner.py'), path.join(local.workspace, 'run_packet.py'));
    fs.writeFileSync(path.join(local.workspace, 'capacityPackets.json'), JSON.stringify(PACKETS));
    const packets = PACKETS.map((packet) => {
      const evidence = packetEvidence(packet, source);
      const folder = path.join(local.workspace, 'work', packet.id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'evidence.md'), evidence);
      return { ...packet, bug_code: this.bugs[packet.id].ticket_code,
        reading_bytes: Buffer.byteLength(evidence) };
    });
    const baseline = JSON.parse(fs.readFileSync(this.env.TEST_AGENT_DEV_CAPACITY_BASELINE));
    assert.strictEqual(baseline.length, BASE_PACKETS.length);
    assert(baseline.every((row) => row.exit_code === 0 && row.skips.length === 0));
    const replicaGroups = ['a', 'b'].map((replica) =>
      balancedGroups(packets.filter((packet) => packet.replica === replica), baseline));
    const groups = Object.fromEntries([2, 4, 8, 16].map((n) =>
      [n, replicaGroups.flatMap((replica) => replica[n / 2])]));
    const study = { helpers: session.helperCount, total_threads: session.helperCount + 1,
      model: MODEL, reasoning_effort: EFFORT, packets, groups: groups[session.helperCount],
      all_level_assignments: groups, baseline,
      workload: 'Two independent replicas of eight source inspection and regression packets; 16 units, 472 tests; disjoint output/temp state; no code edits.' };
    fs.writeFileSync(path.join(local.workspace, 'study.json'), JSON.stringify(study, null, 2));
    fs.writeFileSync(path.join(local.workspace, 'AGENTS.override.md'),
      '# Disposable capacity study\n\n' +
      'This is a bounded live capacity experiment, not normal work discovery. Follow the test coordinator ' +
      'or test worker assignment in the current prompt. The complete shipped Uclusion package is present ' +
      'for provenance; this experiment measures native agents and the MCP runtime, not dispatcher routing. ' +
      'Do not discover or claim other work. Native MCP is connected only to disposable DEV records. ' +
      'Read only the assigned records. No remote writes, configuration edits, source edits, commits, or pushes. ' +
      'Writes are limited to results/<assigned-packet> and the coordinator summary. Each packet has private test state. ' +
      'Command networking is enabled only to support existing loopback HTTP/socket fixtures; do not make other network calls.\n');
    fs.writeFileSync(path.join(local.workspace, 'capacity-worker.md'),
      '# Test worker\n\n' +
      'Your prompt lists the exact packet IDs. Process them sequentially in that order. Do not spawn agents. ' +
      'For each packet: read its entry in study.json, call Uclusion get_job for its exact bug_code once, ' +
      'read work/<packet>/evidence.md, and inspect at most 100 additional focused source lines if needed. ' +
      'Use the provided existing-test runner exactly once: ' +
      '`python3 run_packet.py --source source --output results/<packet> --packet <packet>`. ' +
      'Read the test receipt and any failure output. Write results/<packet>/review.json with keys ' +
      'packet, contract_checked, source_refs (file:line strings), tests_run, tests_exit_code, findings ' +
      '(array; empty if none), and limitation. Ground conclusions in the actual source/test evidence; ' +
      'do not claim full behavior coverage or treat the provisional numeric installer default as agreed. ' +
      'Keep the report under 200 words. Do not edit source or fix failures. Return the completed IDs and concise findings.\n');
    local.proxyExtraArgs = ['--token-audit', '--token-collector', '--token-audit-source', 'codex',
      '--token-audit-client', 'codex', '--token-audit-port', '4318'];
    local.proxyEnvironment.PYTHONDONTWRITEBYTECODE = '1';
    local.capacity = { study, source, before: fingerprintTree(source), artifactDir: session.capacityArtifactDir };
    // Consistent warm-input policy: read all staged source bytes before timing.
    for (const name of Object.keys(local.capacity.before)) fs.readFileSync(path.join(source, name));
    return local;
  }

  async snapshotSemantic() {
    return { records: await this.listComments() };
  }

  async snapshotAfterPhase() { return this.snapshotSemantic(); }

  assertPhase(_phase, before, after) {
    const project = (rows) => rows.map(({ id, body, deleted, resolved }) => ({ id, body, deleted, resolved }))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepStrictEqual(project(after.records), project(before.records), 'Participants changed disposable DEV records');
  }
}

function helperPrompt(session) {
  return `Run the bounded capacity verification batch. Read study.json and capacity-worker.md. ` +
    `Spawn exactly ${session.helperCount} native helpers named worker_1 through worker_${session.helperCount}, ` +
    'fork_turns="none", without model/effort overrides; each receives exactly its corresponding study.groups entry ' +
    'and the instruction to read capacity-worker.md. Start all helpers before waiting for results. ' +
    'Do not do their packet work yourself or spawn replacement/nested helpers. Collect every helper, verify all ' +
    'sixteen results/<packet>/review.json and tests.json files, compare the independent A/B findings, ' +
    'write a concise summary to results/summary.md, ' +
    'and finish. This authorizes these live delegates and the listed local tests. Do not change source or Uclusion records.';
}

function activeEvidence(threads, rootId, expected, started, finished) {
  const helpers = Object.values(threads).filter((thread) => thread.id !== rootId);
  assert.strictEqual(helpers.length, expected, 'Actual helper count differs from configured level');
  assert(helpers.every((thread) => thread.parentThreadId === rootId), 'Nested or unrelated helper found');
  const intervals = [];
  for (const thread of helpers) {
    const starts = new Map();
    for (const record of thread.rollout || []) {
      const event = record.payload || {};
      if (event.type === 'task_started') starts.set(event.turn_id, Date.parse(record.timestamp));
      if (event.type === 'task_complete') {
        const begin = starts.get(event.turn_id);
        assert(Number.isFinite(begin), 'Completed helper turn lacks its start receipt');
        intervals.push({ thread_id: thread.id, turn_id: event.turn_id,
          start_ms: begin, end_ms: Date.parse(record.timestamp) });
        starts.delete(event.turn_id);
      }
    }
    assert(!starts.size && intervals.some((row) => row.thread_id === thread.id), 'Helper work is incomplete');
  }
  const events = intervals.flatMap((row) => [[Math.max(started, row.start_ms), 1],
    [Math.min(finished, row.end_ms), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, previous = started, area = 0, targetMs = 0, peak = 0;
  const timeline = [];
  for (const [at, delta] of events) {
    area += active * (at - previous);
    if (active === expected) targetMs += at - previous;
    active += delta;
    peak = Math.max(peak, active);
    timeline.push({ at_ms: at, active_helpers: active });
    previous = at;
  }
  return { actual_helper_ids: helpers.map((thread) => thread.id), intervals, timeline,
    peak_active_helpers: peak, seconds_at_requested_overlap: targetMs / 1000,
    average_active_helpers: area / (finished - started),
    valid_requested_overlap: peak === expected && targetMs >= 5000 };
}

function redacted(text, secrets) {
  for (const secret of [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

function exportResults(fixture, directory) {
  for (const packet of PACKETS) {
    for (const name of ['tests.json', 'tests.log', 'review.json']) {
      const source = path.join(fixture.workspace, 'results', packet.id, name);
      if (!fs.existsSync(source)) continue;
      assert(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), 'Unsafe result export');
      const target = path.join(directory, 'results', packet.id, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, redacted(fs.readFileSync(source, 'utf8'), fixture.sensitiveValues));
    }
  }
  const summary = path.join(fixture.workspace, 'results', 'summary.md');
  if (fs.existsSync(summary) && fs.lstatSync(summary).isFile() && !fs.lstatSync(summary).isSymbolicLink()) {
    fs.mkdirSync(path.join(directory, 'results'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'results', 'summary.md'),
      redacted(fs.readFileSync(summary, 'utf8'), fixture.sensitiveValues));
  }
}

async function runCapacitySession({ session, fixture, tracePath, sourceEnv, clientVersion }) {
  const directory = session.capacityArtifactDir;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'study.json'), JSON.stringify(fixture.capacity.study, null, 2));
  const telemetry = await startCodexTelemetryReceiver({ multipleConversations: true });
  const native = new NativeCodexSession({ fixture, tracePath, env: sourceEnv,
    telemetryEndpoint: telemetry.endpoint, timeoutMs: TIMEOUT_MS,
    tokenCeiling: TOKEN_CEILING, maxThreads: session.helperCount + 1, model: MODEL, reasoningEffort: EFFORT,
    networkAccess: true, maxTraceBytes: 64 * 1024 * 1024 });
  native.env.PYTHONDONTWRITEBYTECODE = '1';
  const fixtureRoot = path.dirname(fixture.workspace);
  const samplerStop = path.join(directory, 'sampler.stop');
  const samplesPath = path.join(directory, 'resources.jsonl');
  const sampler = spawn('python3', [path.join(HERE, 'capacitySampler.py'), '--home', fixture.sessionHome,
    '--proxy', fixture.proxyPath, '--output', samplesPath, '--stop', samplerStop,
    '--native-stop', path.join(fixtureRoot, 'codex-session.stop'), '--abort', path.join(directory, 'resource-abort.json')],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let samplerError = '';
  sampler.stderr.on('data', (bytes) => { samplerError += bytes; });
  const samplerExit = new Promise((resolve) => sampler.on('exit', (code) => resolve(code)));
  let threads = {}, failure, outcome, workStarted, workFinished, activity;
  const observed = [];
  const capturedIdle = new Set();
  const originalRead = native.readThread.bind(native);
  native.readThread = async (id, includeTurns) => {
    let value;
    try { value = await originalRead(id, includeTurns); }
    catch (error) {
      if (includeTurns && error.rpcCode === -32601 && error.message === 'list_turns is not supported yet' &&
          workStarted && Date.now() - workStarted < 15000) {
        await pause(250);
        return null;
      }
      throw error;
    }
    if (value && !includeTurns) {
      observed.push({ at_ms: Date.now(), id, parent: value.parentThreadId,
        source: value.threadSource, status: value.status });
      if (value.parentThreadId && value.status.type !== 'active' && !capturedIdle.has(id)) {
        await originalRead(id, true);
        capturedIdle.add(id);
      }
    }
    return value;
  };
  try {
    await pause(5000); // Host baseline before starting the private native client.
    await native.start();
    await pause(5000); // Blank client baseline; no synthetic work or worker barrier.
    workStarted = Date.now();
    process.stdout.write(`Starting ${session.helperCount} helpers + root at ${new Date(workStarted).toISOString()}\n`);
    await native.turn(session.prompt);
    workFinished = Date.now();
    threads = await native.histories();
    native.record('completed-histories', { threads });
    activity = activeEvidence(threads, native.rootId, session.helperCount, workStarted, workFinished);
    assert(activity.valid_requested_overlap, 'Requested helper level was not active together for 5 seconds');
    await pause(5000); // Quiescent ownership/socket check after normal work finishes.
    assert.deepStrictEqual(fingerprintTree(fixture.capacity.source), fixture.capacity.before,
      'Participant changed the frozen source');
    for (const packet of PACKETS) {
      const folder = path.join(fixture.workspace, 'results', packet.id);
      const tests = JSON.parse(fs.readFileSync(path.join(folder, 'tests.json')));
      const report = JSON.parse(fs.readFileSync(path.join(folder, 'review.json')));
      const baseline = fixture.capacity.study.baseline.find((row) => row.packet === packet.base_id);
      assert.strictEqual(tests.exit_code, baseline.exit_code, `${packet.id} changed test result`);
      assert.strictEqual(tests.tests_run, baseline.tests_run, `${packet.id} omitted tests`);
      assert.deepStrictEqual(tests.skips, baseline.skips, `${packet.id} skipped tests`);
      assert.strictEqual(report.packet, packet.id);
      assert.strictEqual(report.tests_run, tests.tests_run);
      assert.strictEqual(report.tests_exit_code, tests.exit_code);
      assert(report.contract_checked && report.source_refs?.length && Array.isArray(report.findings));
    }
  } catch (error) {
    failure = error;
    try { threads = await native.histories(); native.record('failure-histories', { threads }); }
    catch (captureError) { failure = new AggregateError([error, captureError], 'Run and history capture failed'); }
  } finally {
    try { await native.close(); outcome = native.exited ? await native.exited : null; }
    catch (error) { failure ||= error; }
    failure ||= native.failure;
    await pause(1500);
    fs.writeFileSync(samplerStop, 'stop\n');
    const code = await samplerExit;
    if (code !== 0) failure ||= new Error(`Resource sampler failed: ${samplerError}`);
    try { await telemetry.close(); } catch (error) { failure ||= error; }
    try { exportResults(fixture, directory); } catch (error) { failure ||= error; }
  }
  const samples = fs.readFileSync(samplesPath, 'utf8').trim().split('\n').map(JSON.parse);
  const census = spawnSync('python3', [path.join(HERE, 'capacitySampler.py'), '--home', fixture.sessionHome,
    '--proxy', fixture.proxyPath, '--snapshot'], { encoding: 'utf8', timeout: 10000 });
  const remaining = census.status === 0 ? JSON.parse(census.stdout).processes : null;
  if (!remaining || remaining.length) failure ||= new Error('Private native cleanup census failed or found remaining processes');
  if (fs.existsSync(path.join(directory, 'resource-abort.json'))) failure ||= new Error('Resource pressure guard stopped case');
  const models = {};
  for (const thread of Object.values(threads)) {
    const contexts = (thread.rollout || []).filter((record) => record.type === 'turn_context').map((record) => record.payload);
    const actual = [...new Set(contexts.map((context) => `${context.model}/${context.effort || context.reasoning_effort}`))];
    if (!actual.length || actual.some((value) => value !== `${MODEL}/${EFFORT}`)) {
      failure ||= new Error(`Missing or unexpected model/effort: ${actual}`);
    }
    models[thread.id] = { parent_thread_id: thread.parentThreadId, observed_model_effort: actual,
      reported_usage: native.usage.get(thread.id) };
  }
  const usage = [...native.usage.values()].reduce((sum, row) => ({ input_tokens: sum.input_tokens + row.input_tokens,
    output_tokens: sum.output_tokens + row.output_tokens }), { input_tokens: 0, output_tokens: 0 });
  fs.writeFileSync(path.join(directory, 'thread-status.json'), JSON.stringify(observed, null, 2));
  fs.writeFileSync(path.join(directory, 'timing.json'), redacted(JSON.stringify({ work_started_ms: workStarted,
    work_finished_ms: workFinished, helper_count: session.helperCount, total_threads: session.helperCount + 1,
    failure: failure?.message, native_outcome: outcome, reported_usage: usage,
    cleanup_process_count: remaining?.length, models, activity }, null, 2), fixture.sensitiveValues));
  let parsed;
  try { parsed = parseAgentTrace(questionClosureNativeEvents(threads), null, 'codex'); }
  catch (error) { failure ||= error; }
  const agentResult = { parsed, invalidJsonLines: [],
    processResult: { command: 'NativeCodexSession/capacity', exitCode: failure ? 1 : 0,
      durationMs: (workFinished || Date.now()) - (workStarted || Date.now()), nativeExitCode: outcome?.code,
      stderr: native.stderr, spawnError: null, timedOut: false, callbackFailures: [] },
    modelRecord: { client: 'codex', client_version: clientVersion, primary_session_id: native.rootId,
      resolved_model: MODEL, threads: models, session_ids: Object.keys(models),
      reported_usage: { scope: 'native root and helpers', usage } } };
  if (failure) throw Object.assign(failure, { agentResult });
  return agentResult;
}

export function assertCapacityTranscript({ parsed, targets }) {
  const rootId = parsed.events[0]?.thread_id;
  const mcpCalls = parsed.toolCalls.filter((call) => call.name.startsWith('mcp__'));
  assert(mcpCalls.every((call) => /(?:__|\.)get_job$/.test(call.name)), 'Unapproved MCP operation');
  const byHelper = new Map();
  for (const call of mcpCalls.filter((item) => item.success)) {
    const owner = parsed.events[call.eventIndex]?.item.nativeThreadId;
    assert(owner && owner !== rootId, 'Coordinator performed helper packet reads');
    const codes = byHelper.get(owner) || [];
    codes.push(call.input.short_code_id);
    byHelper.set(owner, codes);
  }
  const canonical = (groups) => groups.map((group) => JSON.stringify([...group].sort())).sort();
  assert.deepStrictEqual(canonical([...byHelper.values()]),
    canonical(targets.packetGroups.map((group) => group.map((id) => targets.packetCodes[id]))),
    'Actual helper packet ownership differs from the frozen allocation');
  for (const code of Object.values(targets.packetCodes)) {
    assert(parsed.toolCalls.some((call) => /(?:__|\.)get_job$/.test(call.name) &&
      call.input.short_code_id === code && call.success &&
      parsed.events[call.eventIndex]?.item.nativeThreadId !== rootId), `No helper MCP read for ${code}`);
  }
}

async function main() {
  const artifactDir = process.env.TEST_AGENT_DEV_ARTIFACT_DIR;
  const webUiRoot = process.env.TEST_AGENT_DEV_WEB_UI_ROOT;
  assert(artifactDir && webUiRoot && process.env.TEST_AGENT_DEV_CAPACITY_BASELINE);
  const levels = (process.env.TEST_AGENT_DEV_CAPACITY_HELPERS || '16').split(',').map(Number);
  assert(levels.length && levels.every((n) => [2, 4, 8, 16].includes(n)));
  const receipts = [];
  const cleanup = createPendingMarketCleanup({ artifactDir, deleteMarket: async (marketId) => {
    const result = await deleteIntegrationTestMarket(marketId);
    receipts.push({ market_id: marketId, deleted_at: new Date().toISOString(), result });
    fs.writeFileSync(path.join(artifactDir, 'cleanup-receipts.json'), JSON.stringify(receipts, null, 2));
    return result;
  } });
  const result = await runAfterPendingMarketCleanup(cleanup, () => executeSemanticHarness({
    artifactDir, marketCleanup: cleanup, webUiRoot, timeoutMs: TIMEOUT_MS,
    seedPinsPath: path.join(HERE, 'last-known-good.json'), catalog: 'native-capacity',
    sessions: levels.map((helperCount) => ({ id: `capacity-${helperCount}`, phase: `helpers-${helperCount}`,
      client: 'codex', scenario: 'fixed-eight-verification-packets', helperCount,
      key: `capacity/${helperCount}`, traceName: `capacity-${helperCount}.jsonl`,
      capacityArtifactDir: path.join(artifactDir, `helpers-${helperCount}`),
      codexReportedTokenCeiling: TOKEN_CEILING })),
    reportProgress: (message) => process.stdout.write(`${message}\n`),
    dependencies: { createFixture: (options) => new CapacityFixture(options), buildPrompt: helperPrompt,
      runAgentSession: runCapacitySession, assertTranscript: assertCapacityTranscript }
  }));
  process.stdout.write(`Capacity run: ${result.status}; ${artifactDir}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
