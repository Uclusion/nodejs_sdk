import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { NativeCodexSession } from './nativeCodexSession.js';
import { startCodexTelemetryReceiver } from './codexTelemetry.js';
import { parseAgentTrace } from './trace.js';

// Project completed native item histories into the existing semantic grader's
// event format. Ordering and results come from the actual per-item timestamps.
export function questionClosureNativeEvents(threads) {
  for (const thread of Object.values(threads)) {
    assert(!thread.historyUnavailable, `Native helper history is incomplete: ${thread.id}`);
  }
  const roots = Object.values(threads).filter((thread) => !thread.parentThreadId);
  assert.strictEqual(roots.length, 1, 'Native history must identify one coordinator root');
  const events = Object.values(threads).flatMap((thread) => thread.turns.flatMap((turn) =>
    turn.items.filter((item) => ['commandExecution', 'mcpToolCall'].includes(item.type))
      .flatMap((item) => {
        assert(Number.isFinite(item.startedAtMs) && Number.isFinite(item.completedAtMs),
          `Native item ${item.id} has incomplete timing evidence`);
        const projected = { ...item, nativeThreadId: thread.id,
          type: item.type === 'mcpToolCall' ? 'mcp_tool_call' : 'command_execution',
          exit_code: item.exitCode, aggregated_output: item.aggregatedOutput };
        return [
          { type: 'item.started', at: item.startedAtMs, item: projected },
          { type: 'item.completed', at: item.completedAtMs, item: projected }
        ];
      }))).sort((a, b) => a.at - b.at ||
        (a.type === b.type ? 0 : a.type === 'item.started' ? -1 : 1));
  return [{ type: 'thread.started', thread_id: roots[0].id }, ...events];
}

export async function runQuestionClosureNativeSession({
  session, fixture, tracePath, timeoutMs, clientVersion, sourceEnv
}) {
  const startedAt = Date.now();
  const telemetry = await startCodexTelemetryReceiver({ multipleConversations: true });
  const native = new NativeCodexSession({ fixture, tracePath, env: sourceEnv,
    telemetryEndpoint: telemetry.endpoint, timeoutMs,
    tokenCeiling: session.codexReportedTokenCeiling ?? 500000, maxThreads: 3 });
  let threads;
  let failure;
  let outcome;
  const models = {};
  try {
    await native.start();
    await native.turn(session.prompt);
    threads = await native.histories();
    native.record('completed-histories', { threads });
    for (const [relative, fingerprint] of Object.entries(fixture.stagedSource.skill)) {
      const bytes = fs.readFileSync(path.join(fixture.stagedSource.skillTarget, relative));
      assert.strictEqual(createHash('sha256').update(bytes).digest('hex'), fingerprint.sha256,
        `Participant modified staged instructions: ${relative}`);
    }
    for (const thread of Object.values(threads)) {
      assert(native.usage.has(thread.id), `Native session omitted usage for ${thread.id}`);
      models[thread.id] = {
        parent_thread_id: thread.parentThreadId,
        model: await telemetry.resolvedModel(thread.id),
        reported_usage: native.usage.get(thread.id)
      };
    }
  } catch (error) {
    failure = error;
    try {
      threads = await native.histories();
      native.record('failure-histories', { threads });
    } catch (captureError) {
      failure = new AggregateError([failure, captureError], 'Native run and evidence capture failed');
    }
  } finally {
    try {
      await native.close();
      // close already waited for termination; never await it again after a timeout.
      outcome = native.exited ? await native.exited : null;
    } catch (error) { failure ||= error; }
    failure ||= native.failure;
    try { await telemetry.close(); } catch (error) { failure ||= error; }
  }
  const usage = [...native.usage.values()].reduce((total, item) => ({
    input_tokens: total.input_tokens + item.input_tokens,
    output_tokens: total.output_tokens + item.output_tokens
  }), { input_tokens: 0, output_tokens: 0 });
  let parsed;
  try {
    if (threads) parsed = parseAgentTrace(questionClosureNativeEvents(threads), null, 'codex');
  } catch (error) { failure ||= error; }
  if (!parsed && !failure) failure = new Error('Native session produced no complete history');
  const agentResult = {
    processResult: {
      command: 'NativeCodexSession',
      // This is the adapter's outcome; the terminal's exact status is separate.
      exitCode: failure ? 1 : 0, nativeExitCode: outcome?.code, nativeSignal: outcome?.signal,
      spawnError: null, timedOut: false, callbackFailures: [], stderr: native.stderr,
      durationMs: Date.now() - startedAt
    },
    invalidJsonLines: [],
    parsed,
    modelRecord: {
      client: 'codex', client_version: clientVersion, primary_session_id: native.rootId,
      resolved_model: models[native.rootId]?.model,
      threads: models, session_ids: Object.keys(models),
      reported_usage: { scope: 'native root and helpers', usage },
      source: 'native Codex history and aggregate root/helper usage'
    }
  };
  if (failure) throw Object.assign(failure, { agentResult });
  return agentResult;
}
