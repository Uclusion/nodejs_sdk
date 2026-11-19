import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeCodexSession } from '../nativeCodexSession.js';

describe('native continuing-session accounting', () => {
  let root;
  let session;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-unit-'));
    session = new NativeCodexSession({ fixture: { workspace: root, sessionHome: root },
      env: {}, tracePath: path.join(root, 'trace.jsonl'), tokenCeiling: 100 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('merges delayed cumulative reports without lowering root or child usage', () => {
    session.recordUsage('root', 20, 5);
    session.recordUsage('child', 30, 10);
    session.recordUsage('child', 10, 3);
    assert.strictEqual(session.reportedTokens(), 65);
    session.recordUsage('root', 70, 5);
    assert.match(session.failure.message, /exceeded/);
    session.recordUsage('child', 50, 15);
    assert.strictEqual(session.reportedTokens(), 140, 'Shutdown usage must remain accounted after the guard fires');
  });

  it('observes child rollouts while they run and counts each update once', () => {
    const directory = path.join(root, '.codex', 'sessions', '2026');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'child.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'child' } }) + '\n');
    session.scanUsage();
    assert(session.threadIds.has('child'));
    const usage = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 40, output_tokens: 7 } } } });
    fs.appendFileSync(file, usage.slice(0, 20));
    session.scanUsage();
    assert.strictEqual(session.reportedTokens(), 0);
    fs.appendFileSync(file, usage.slice(20) + '\n');
    session.scanUsage();
    session.scanUsage();
    assert.strictEqual(session.reportedTokens(), 47);
    const records = fs.readFileSync(session.tracePath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
    assert.strictEqual(records.length, 2, 'Native records must be preserved exactly once');
  });

  it('fails closed on malformed child usage instead of reporting zero', () => {
    assert.throws(() => session.recordUsage('child', undefined, 1), /Malformed/);
    assert.throws(() => session.recordUsage('child', -1, 1), /Malformed/);
  });

  it('retains retired helper evidence while omitting an auxiliary title thread', async () => {
    session.threadIds = new Set(['child', 'title']);
    session.lastThreads.set('child', { id: 'child', parentThreadId: 'root',
      turns: [{ items: [{ type: 'agentMessage', text: 'Completed design R-1 v1' }] }] });
    session.lastThreads.set('title', { id: 'title', threadSource: 'thread_title', turns: [] });
    session.request = async (_method, { threadId }) => {
      throw Object.assign(new Error(`thread not loaded: ${threadId}`), { rpcCode: -32600 });
    };
    const histories = await session.histories();
    assert.deepStrictEqual(Object.keys(histories), ['child']);
    assert.strictEqual(histories.child.turns[0].items[0].text, 'Completed design R-1 v1');
    assert.match(histories.child.historyUnavailable, /thread not loaded/);
    assert.strictEqual(session.failure, null);
    session.request = async () => { throw new Error('Transport closed'); };
    await assert.rejects(session.histories(), /Transport closed/);
  });
});
