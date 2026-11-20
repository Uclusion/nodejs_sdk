import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import websocket from 'websocket';
import { codexMcpOverride, executableFor, isolatedSessionEnvironment } from './clientAdapters.js';
import { DEFAULT_MAX_STDERR_BYTES, DEFAULT_MAX_TRACE_BYTES } from './process.js';

// One native process retains the real coordinator and its helper threads across
// ordinary user turns. This adapter never manufactures participant tool calls.
export class NativeCodexSession {
  constructor({ fixture, tracePath, env, telemetryEndpoint, timeoutMs = 1200000,
    tokenCeiling = 4000000, maxThreads = 3 }) {
    this.fixture = fixture;
    this.tracePath = tracePath;
    this.env = isolatedSessionEnvironment(env, 'codex', fixture);
    this.telemetryEndpoint = telemetryEndpoint;
    this.timeoutMs = timeoutMs;
    this.tokenCeiling = tokenCeiling;
    this.maxThreads = maxThreads;
    this.requests = new Map();
    this.usage = new Map();
    this.threadIds = new Set();
    this.lastThreads = new Map();
    this.unavailableHistories = new Map();
    this.nextId = 0;
    this.traceBytes = 0;
    this.stderr = '';
    this.failure = null;
    this.closed = false;
  }

  record(direction, message) {
    const record = { direction, at: Date.now(), message };
    const line = `${JSON.stringify(record)}\n`;
    this.traceBytes += Buffer.byteLength(line);
    assert(this.traceBytes <= DEFAULT_MAX_TRACE_BYTES, 'Native trace exceeded 16 MiB');
    fs.appendFileSync(this.tracePath, line);
  }

  fail(error) {
    this.failure ||= error;
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.requests.clear();
    if (this.stopPath) fs.writeFileSync(this.stopPath, 'stop\n');
  }

  receive(message) {
    this.record('from-client', message);
    if (message.id !== undefined && !message.method) {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), {
        rpcCode: message.error.code
      }));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      this.send({ id: message.id, error: { code: -32601,
        message: 'Unexpected interactive request in unattended acceptance run' } });
      throw new Error(`Native session requires unexpected interaction: ${message.method}`);
    }
    if (message.method === 'thread/started') {
      this.threadIds.add(message.params.thread.id);
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const { threadId, tokenUsage } = message.params;
      this.threadIds.add(threadId);
      this.recordUsage(threadId, tokenUsage.total.inputTokens, tokenUsage.total.outputTokens);
    }
  }

  recordUsage(threadId, input, output) {
    assert(Number.isInteger(input) && input >= 0 && Number.isInteger(output) && output >= 0,
      `Malformed native usage for ${threadId}`);
    const previous = this.usage.get(threadId);
    this.usage.set(threadId, {
      input_tokens: Math.max(input, previous?.input_tokens || 0),
      output_tokens: Math.max(output, previous?.output_tokens || 0)
    });
    if (this.reportedTokens() > this.tokenCeiling && !this.failure) {
      this.fail(new Error(`Native root/helper usage exceeded ${this.tokenCeiling} tokens`));
    }
  }

  reportedTokens() {
    return [...this.usage.values()].reduce((sum, usage) =>
      sum + usage.input_tokens + usage.output_tokens, 0);
  }

  send(message) {
    this.record('to-client', message);
    this.connection.sendUTF(JSON.stringify(message));
  }

  request(method, params) {
    if (this.failure && !['thread/read', 'thread/loaded/list'].includes(method)) {
      return Promise.reject(this.failure);
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(
        `Native ${method} did not respond within 30 seconds`)), 30000);
      this.requests.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.requests.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async readThread(id, includeTurns) {
    try {
      const { thread } = await this.request('thread/read', { threadId: id, includeTurns });
      this.lastThreads.set(id, includeTurns ? thread : {
        ...thread, turns: this.lastThreads.get(id)?.turns || []
      });
      return thread;
    } catch (error) {
      if (error.rpcCode !== -32600 || !error.message.startsWith('thread not loaded: ')) throw error;
      // Ordinary clients retire auxiliary threads and completed helpers. Keep
      // their previous projection and persisted rollout without resuming them.
      if (!this.unavailableHistories.has(id)) {
        this.unavailableHistories.set(id, error.message);
        this.record('native-history-unavailable', { threadId: id, error: error.message });
      }
      return null;
    }
  }

  async start() {
    fs.mkdirSync(this.env.CODEX_HOME, { recursive: true, mode: 0o700 });
    const socketPath = path.join(this.env.CODEX_HOME, 'app-server-control', 'app-server-control.sock');
    const fixtureRoot = path.dirname(this.fixture.workspace);
    this.stopPath = path.join(fixtureRoot, 'codex-session.stop');
    this.inputPath = path.join(fixtureRoot, 'codex-session-input.jsonl');
    this.terminalPath = path.join(fixtureRoot, 'codex-terminal.log');
    fs.writeFileSync(this.inputPath, '', { mode: 0o600 });
    this.fixture.proxyExtraArgs = [...(this.fixture.proxyExtraArgs || []), '--codex-native'];
    this.fixture.proxyEnvironment = { ...this.fixture.proxyEnvironment, CODEX_HOME: this.env.CODEX_HOME };
    // The maintained ordinary terminal launcher uses a private persisted config;
    // invocation overrides would select a different native runtime.
    fs.writeFileSync(path.join(this.env.CODEX_HOME, 'config.toml'), [
      'approval_policy="never"', 'sandbox_mode="workspace-write"',
      'sandbox_workspace_write={network_access=false}',
      `features={plugins=false,apps=false,remote_plugin=false,multi_agent_v2={enabled=true,max_concurrent_threads_per_session=${this.maxThreads}}}`,
      `projects.${JSON.stringify(this.fixture.workspace)}={trust_level="trusted"}`,
      `otel={log_user_prompt=false,exporter={otlp-http={endpoint=${JSON.stringify(this.telemetryEndpoint)},protocol="binary"}}}`,
      codexMcpOverride(this.fixture), ''
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    if (this.env.CODEX_API_KEY) {
      const login = spawnSync(executableFor('codex'), ['login', '--with-api-key'], {
        env: this.env, input: this.env.CODEX_API_KEY, encoding: 'utf8', timeout: 30000,
        maxBuffer: DEFAULT_MAX_STDERR_BYTES
      });
      assert.strictEqual(login.status, 0, 'Private ordinary Codex API-key login failed');
    }
    const helper = fileURLToPath(new URL('./tokenBreakdownCodexSession.py', import.meta.url));
    this.process = spawn('python3', [helper, '--scripts', path.dirname(this.fixture.proxyPath),
      '--workspace', this.fixture.workspace, '--log', this.terminalPath, '--stop', this.stopPath,
      '--input', this.inputPath, '--timeout', String(Math.floor(this.timeoutMs / 1000)),
      '--', executableFor('codex')], {
      cwd: this.fixture.workspace, env: this.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process.on('error', (error) => this.fail(error));
    this.exited = new Promise((resolve) => this.process.on('exit', (code, signal) => {
      resolve({ code, signal });
      if (!this.closed) this.fail(new Error(`Ordinary Codex terminal exited ${code}/${signal}: ${this.stderr}`));
    }));
    this.process.stderr.on('data', (chunk) => {
      this.stderr = Buffer.from(this.stderr + chunk.toString()).subarray(-DEFAULT_MAX_STDERR_BYTES).toString();
    });
    this.launcherOutput = '';
    this.process.stdout.on('data', (chunk) => {
      this.launcherOutput = Buffer.from(this.launcherOutput + chunk.toString())
        .subarray(-DEFAULT_MAX_STDERR_BYTES).toString();
    });
    this.timer = setTimeout(() => this.fail(new Error(
      `Native handoff exceeded hard timeout ${this.timeoutMs}ms`)), this.timeoutMs);
    this.usageTimer = setInterval(() => {
      try { this.scanUsage(); } catch (error) { this.fail(error); }
    }, 500);
    const socketDeadline = Date.now() + 30000;
    while (!fs.existsSync(socketPath)) {
      if (this.failure) throw this.failure;
      assert(Date.now() < socketDeadline, 'Ordinary Codex did not create its private control socket');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const client = new websocket.client({ maxReceivedMessageSize: DEFAULT_MAX_TRACE_BYTES });
    this.connection = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.abort(); reject(new Error('Native socket handshake timed out')); }, 15000);
      client.once('connectFailed', (error) => { clearTimeout(timer); reject(error); });
      client.once('connect', (connection) => { clearTimeout(timer); resolve(connection); });
      client.connect('ws://localhost/', undefined, undefined, undefined, { socketPath });
    });
    this.connection.on('error', (error) => this.fail(error));
    this.connection.on('close', () => {
      if (!this.closed) this.fail(new Error('Native control socket closed unexpectedly'));
    });
    this.connection.on('message', (message) => {
      try {
        assert.strictEqual(message.type, 'utf8', 'Native socket emitted a non-text message');
        this.receive(JSON.parse(message.utf8Data));
      } catch (error) { this.fail(error); }
    });
    await this.request('initialize', { clientInfo: { name: 'uclusion_agent_dev_observer', version: '1' },
      capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    this.config = await this.request('config/read', { includeLayers: false });
    return this.config;
  }

  async turn(text) {
    if (this.failure) throw this.failure;
    assert(typeof text === 'string' && !/[\r\n]/.test(text), 'Terminal input must be one ordinary line');
    this.record('frontend-input', { text });
    fs.appendFileSync(this.inputPath, `${JSON.stringify({ text })}\n`);
    while (!this.failure) {
      const loaded = await this.request('thread/loaded/list', {});
      let busy = false;
      let root;
      for (const id of loaded.data) {
        const thread = await this.readThread(id, false);
        if (!thread) continue;
        if (thread.threadSource === 'thread_title') continue;
        this.threadIds.add(id);
        if (thread.status.type === 'active') busy = true;
        if (!thread.parentThreadId && thread.threadSource === 'user') {
          assert(!this.rootId || this.rootId === id, 'Ordinary client replaced its coordinator root');
          this.rootId = id;
          root = thread;
        }
      }
      if (root && !busy) {
        const thread = await this.readThread(this.rootId, true);
        if (!thread) continue;
        const accepted = thread.turns.some((turn) => turn.items.some((item) =>
          item.type === 'userMessage' && item.content.some((part) => part.text === text)));
        const last = thread.turns.at(-1);
        if (accepted && last?.status === 'completed') return last.id;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw this.failure;
  }

  async histories() {
    this.scanUsage();
    const threads = {};
    const pending = [...this.threadIds];
    for (let index = 0; index < pending.length; index += 1) {
      const id = pending[index];
      if (threads[id]) continue;
      const metadata = this.lastThreads.get(id) || await this.readThread(id, false);
      if (metadata?.threadSource === 'thread_title') continue;
      const current = await this.readThread(id, true);
      const thread = structuredClone(current || this.lastThreads.get(id) || { id, turns: [] });
      if (thread.threadSource === 'thread_title') continue;
      if (!current) thread.historyUnavailable = this.unavailableHistories.get(id);
      threads[id] = thread;
      assert(thread.turns.every((turn) => !turn.itemsView || turn.itemsView === 'full'),
        `Native history is incomplete for ${id}`);
      for (const item of thread.turns.flatMap((turn) => turn.items)) {
        const children = item.type === 'subAgentActivity' ? [item.agentThreadId] :
          item.type === 'collabAgentToolCall' ? item.receiverThreadIds : [];
        for (const child of children) {
          if (!threads[child]) pending.push(child);
          this.threadIds.add(child);
        }
      }
      const rolloutPath = thread.path || [...(this.rolloutOffsets || [])]
        .find(([, state]) => state.threadId === id)?.[0];
      if (rolloutPath) {
        const root = path.resolve(this.fixture.sessionHome, '.codex');
        const file = fs.realpathSync(rolloutPath);
        assert(file.startsWith(`${root}${path.sep}`), 'Native rollout escaped its isolated HOME');
        const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        for (const record of records) {
          const usage = record.payload?.type === 'token_count' && record.payload.info?.total_token_usage;
          if (usage) this.recordUsage(id, usage.input_tokens, usage.output_tokens);
        }
        thread.rollout = records;
      }
    }
    return threads;
  }

  // Child usage notifications vary across client releases. Watch the native
  // persisted rollouts too, so active children count before the root returns.
  scanUsage() {
    if (this.terminalPath && fs.existsSync(this.terminalPath)) {
      assert(fs.statSync(this.terminalPath).size <= DEFAULT_MAX_TRACE_BYTES,
        'Native terminal exceeded 16 MiB');
    }
    const root = path.join(this.fixture.sessionHome, '.codex', 'sessions');
    if (!fs.existsSync(root)) return;
    this.rolloutOffsets ||= new Map();
    for (const relative of fs.readdirSync(root, { recursive: true })) {
      if (!relative.endsWith('.jsonl')) continue;
      const file = path.join(root, relative);
      const state = this.rolloutOffsets.get(file) || { offset: 0, buffer: '', threadId: null };
      const size = fs.statSync(file).size;
      if (size === state.offset) continue;
      assert(size >= state.offset, 'Native rollout shrank during a live session');
      assert(size <= DEFAULT_MAX_TRACE_BYTES, 'Native rollout exceeded trace limit');
      const bytes = Buffer.alloc(size - state.offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, bytes, 0, bytes.length, state.offset); }
      finally { fs.closeSync(fd); }
      state.offset = size;
      const lines = (state.buffer + bytes.toString('utf8')).split('\n');
      state.buffer = lines.pop();
      const records = lines.filter(Boolean).map((line) => JSON.parse(line));
      for (const record of records) {
        if (record.type === 'session_meta') {
          state.threadId = record.payload.id;
          this.threadIds.add(state.threadId);
        }
        const usage = record.payload?.type === 'token_count' && record.payload.info?.total_token_usage;
        if (usage) {
          assert(state.threadId, 'Native usage appeared before its thread identity');
          this.recordUsage(state.threadId, usage.input_tokens, usage.output_tokens);
        }
      }
      if (records.length) this.record('native-rollout', { threadId: state.threadId, records });
      this.rolloutOffsets.set(file, state);
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.stopPath) fs.writeFileSync(this.stopPath, 'stop\n');
    let timeout;
    try {
      if (this.exited) {
        const outcome = await Promise.race([this.exited, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Ordinary Codex cleanup did not finish')), 25000);
        })]);
        assert([0, 3].includes(outcome.code), `Ordinary Codex cleanup exited ${outcome.code}`);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(this.usageTimer);
      try { this.scanUsage(); } finally {
        this.connection?.close();
        if (this.terminalPath && fs.existsSync(this.terminalPath)) {
          this.record('native-terminal', { text: fs.readFileSync(this.terminalPath, 'utf8') });
        }
        if (this.launcherOutput) this.record('native-launcher-stdout', { text: this.launcherOutput });
      }
    }
  }
}
