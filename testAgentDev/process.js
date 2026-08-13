import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';

export const DEFAULT_MAX_TRACE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

export function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        child.kill('SIGKILL');
      } catch (fallbackError) {
        if (fallbackError.code !== 'ESRCH') {
          throw fallbackError;
        }
      }
    }
  }
}

function consumeJsonLines(state, chunk, onJsonEvent) {
  state.buffer += chunk.toString('utf8');
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      state.events.push(event);
      if (onJsonEvent) {
        const pending = Promise.resolve(onJsonEvent(event));
        state.eventPromises.push(pending);
      }
    } catch (error) {
      state.invalidJsonLines.push({ line, error: 'INVALID_JSON' });
    }
  }
}

function structuredTraceLine(line, lineNumber, error) {
  try {
    return JSON.stringify(JSON.parse(line));
  } catch (_parseError) {
    return JSON.stringify({
      type: 'harness.invalid_json',
      line_number: lineNumber,
      parse_error: error?.error || 'INVALID_JSON',
      raw_bytes: Buffer.byteLength(line, 'utf8'),
      raw_sha256: createHash('sha256').update(line, 'utf8').digest('hex')
    });
  }
}

function ensureStructuredTrace(tracePath, invalidJsonLines) {
  if (!tracePath || invalidJsonLines.length === 0) {
    return;
  }
  const text = fs.readFileSync(tracePath, 'utf8');
  const invalidByLine = new Map(invalidJsonLines.map((entry) => [entry.line, entry]));
  const lines = text.split('\n');
  const rewritten = lines
    .filter((line, index) => line.trim() || index < lines.length - 1)
    .map((line, index) => structuredTraceLine(line, index + 1, invalidByLine.get(line)))
    .join('\n');
  fs.writeFileSync(tracePath, rewritten ? `${rewritten}\n` : '');
}

export async function runCapturedProcess({
  command,
  args = [],
  cwd,
  env,
  timeoutMs,
  tracePath,
  onJsonEvent,
  stdinText,
  appendTrace = false,
  maxTraceBytes = DEFAULT_MAX_TRACE_BYTES,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  spawnImpl = spawn,
  killTree = killProcessTree
}) {
  if (!Number.isSafeInteger(maxTraceBytes) || maxTraceBytes < 256) {
    throw new Error('maxTraceBytes must be an integer of at least 256 bytes');
  }
  if (!Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 0) {
    throw new Error('maxStderrBytes must be a nonnegative integer');
  }
  const startedAt = new Date();
  if (tracePath) {
    fs.writeFileSync(tracePath, '', { flag: appendTrace ? 'a' : 'w' });
  }
  const child = spawnImpl(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const stdoutState = {
    buffer: '',
    events: [],
    invalidJsonLines: [],
    eventPromises: []
  };
  let stdout = '';
  const stderrChunks = [];
  let stderrBytes = 0;
  let stderrRetainedBytes = 0;
  let traceBytes = 0;
  let traceLimitExceeded = false;
  let timedOut = false;
  let spawnError;

  child.stdout.on('data', (chunk) => {
    traceBytes += chunk.length;
    if (traceLimitExceeded) {
      return;
    }
    if (traceBytes > maxTraceBytes) {
      traceLimitExceeded = true;
      killTree(child);
      return;
    }
    if (tracePath) {
      fs.appendFileSync(tracePath, chunk);
    }
    stdout += chunk.toString('utf8');
    consumeJsonLines(stdoutState, chunk, onJsonEvent);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    const remaining = maxStderrBytes - stderrRetainedBytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      stderrChunks.push(retained);
      stderrRetainedBytes += retained.length;
    }
  });
  child.on('error', (error) => {
    spawnError = error;
  });

  if (stdinText !== undefined) {
    child.stdin.end(stdinText);
  } else {
    child.stdin.end();
  }

  const completion = new Promise((resolve) => {
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutMs);
  timeout.unref?.();

  const { exitCode, signal } = await completion;
  clearTimeout(timeout);
  // A client can leave monitors, hooks, or MCP proxies behind after its main
  // process exits. They share the detached process group, so clean the whole
  // session tree even on an ordinary exit.
  killTree(child);
  if (!traceLimitExceeded && stdoutState.buffer.trim()) {
    try {
      const event = JSON.parse(stdoutState.buffer);
      stdoutState.events.push(event);
      if (onJsonEvent) {
        stdoutState.eventPromises.push(Promise.resolve(onJsonEvent(event)));
      }
    } catch (error) {
      stdoutState.invalidJsonLines.push({
        line: stdoutState.buffer,
        error: 'INVALID_JSON'
      });
    }
  }
  const callbackResults = await Promise.allSettled(stdoutState.eventPromises);
  const callbackFailures = callbackResults
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.stack || String(result.reason));
  const finishedAt = new Date();
  if (traceLimitExceeded && tracePath) {
    const marker = `${JSON.stringify({
      type: 'harness.trace_limit_exceeded',
      max_bytes: maxTraceBytes,
      observed_bytes: traceBytes
    })}\n`;
    if (Buffer.byteLength(marker, 'utf8') > maxTraceBytes) {
      throw new Error('maxTraceBytes is too small for the structured limit marker');
    }
    // A partial client line would not be honest JSONL. Replace the bounded
    // capture with one structured failure record rather than truncating it.
    fs.writeFileSync(tracePath, marker);
  } else {
    ensureStructuredTrace(tracePath, stdoutState.invalidJsonLines);
  }
  let stderr = Buffer.concat(stderrChunks).toString('utf8');
  const omittedStderrBytes = stderrBytes - stderrRetainedBytes;
  if (omittedStderrBytes > 0) {
    stderr += `${stderr.endsWith('\n') || !stderr ? '' : '\n'}` +
      `[harness stderr truncated: ${omittedStderrBytes} bytes omitted]\n`;
  }
  return {
    command,
    args,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    exitCode,
    signal,
    timedOut,
    traceLimitExceeded,
    traceBytes,
    stderrBytes,
    stderrRetainedBytes,
    spawnError: spawnError?.stack || null,
    stdout,
    stderr,
    events: stdoutState.events,
    invalidJsonLines: stdoutState.invalidJsonLines.map((entry) => ({
      error: 'INVALID_JSON',
      raw_bytes: Buffer.byteLength(entry.line, 'utf8'),
      raw_sha256: createHash('sha256').update(entry.line, 'utf8').digest('hex')
    })),
    callbackFailures
  };
}

export function startBackgroundProcess({ command, args = [], cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  let spawnError;
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('error', (error) => { spawnError = error; });
  return {
    child,
    status() {
      return {
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        spawnError: spawnError?.stack || null,
        stdout,
        stderr
      };
    },
    stop() {
      killProcessTree(child);
      child.stdin.destroy();
    }
  };
}
