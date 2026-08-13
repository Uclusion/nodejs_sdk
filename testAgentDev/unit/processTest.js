import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCapturedProcess } from '../process.js';

describe('agent dev process capture', () => {
  it('preserves raw stdout/stderr and kills a timed-out process tree', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-process-unit-'));
    const tracePath = path.join(directory, 'trace.jsonl');
    const result = await runCapturedProcess({
      command: process.execPath,
      args: ['-e', [
        'process.stdout.write(JSON.stringify({model:"fake"})+"\\n")',
        'process.stderr.write("exact failure diagnostic\\n")',
        'setInterval(()=>{},1000)'
      ].join(';')],
      cwd: directory,
      env: process.env,
      timeoutMs: 150,
      tracePath
    });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.signal, 'SIGKILL');
    assert.strictEqual(result.stderr, 'exact failure diagnostic\n');
    assert.strictEqual(
      fs.readFileSync(tracePath, 'utf8'),
      `${JSON.stringify({ model: 'fake' })}\n`
    );
    assert.deepStrictEqual(result.events, [{ model: 'fake' }]);
  }).timeout(5000);

  it('turns malformed client stdout into a valid structured failure trace', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-process-unit-'));
    const tracePath = path.join(directory, 'trace.jsonl');
    const result = await runCapturedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("not-json\\n")'],
      cwd: directory,
      env: process.env,
      timeoutMs: 1000,
      tracePath
    });
    assert.strictEqual(result.invalidJsonLines.length, 1);
    const archived = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    assert.strictEqual(archived.type, 'harness.invalid_json');
    assert.strictEqual(archived.raw_bytes, Buffer.byteLength('not-json'));
    assert.match(archived.raw_sha256, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(archived).includes('not-json'));
  });

  it('never stores reversible malformed output containing a secret', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-process-unit-'));
    const tracePath = path.join(directory, 'trace.jsonl');
    const secret = 'provider-canary-super-secret';
    await runCapturedProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(`bad ${secret} line\n`)})`],
      cwd: directory,
      env: process.env,
      timeoutMs: 1000,
      tracePath
    });
    const archived = fs.readFileSync(tracePath, 'utf8');
    assert(!archived.includes(secret));
    for (const value of Object.values(JSON.parse(archived))) {
      if (typeof value === 'string') {
        assert(!Buffer.from(value, 'base64').toString('utf8').includes(secret));
      }
    }
  });

  it('caps retained stderr and reports the exact omitted byte count', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-process-unit-'));
    const result = await runCapturedProcess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("abcdefghijklmnopqrst")'],
      cwd: directory,
      env: process.env,
      timeoutMs: 1000,
      maxStderrBytes: 8
    });
    assert.strictEqual(result.stderrBytes, 20);
    assert.strictEqual(result.stderrRetainedBytes, 8);
    assert.strictEqual(
      result.stderr,
      'abcdefgh\n[harness stderr truncated: 12 bytes omitted]\n'
    );
  });

  it('kills noisy stdout and replaces any partial capture with structured JSONL', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-process-unit-'));
    const tracePath = path.join(directory, 'trace.jsonl');
    const result = await runCapturedProcess({
      command: process.execPath,
      args: ['-e', [
        'const line=JSON.stringify({type:"noise",value:"x".repeat(200)})+"\\n"',
        'setInterval(()=>process.stdout.write(line),0)'
      ].join(';')],
      cwd: directory,
      env: process.env,
      timeoutMs: 5000,
      tracePath,
      maxTraceBytes: 512
    });
    assert.strictEqual(result.traceLimitExceeded, true);
    assert(result.traceBytes > 512);
    const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
      type: 'harness.trace_limit_exceeded',
      max_bytes: 512,
      observed_bytes: result.traceBytes
    });
  }).timeout(5000);
});
