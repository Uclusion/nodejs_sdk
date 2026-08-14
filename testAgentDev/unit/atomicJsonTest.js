import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJson, ratchetIfAllPassed } from '../atomicJson.js';

describe('agent dev last-known-good ratchet', () => {
  it('preserves baseline bytes on any failure', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pin-unit-'));
    const target = path.join(directory, 'last-known-good.json');
    const baseline = Buffer.from('{"baseline":true}\n');
    fs.writeFileSync(target, baseline);
    const results = Array.from({ length: 9 }, (_unused, index) => ({
      status: index === 4 ? 'failed' : 'passed'
    }));
    assert.strictEqual(ratchetIfAllPassed({
      results,
      expectedCount: results.length,
      targetPath: target,
      pins: { baseline: false }
    }), false);
    assert(baseline.equals(fs.readFileSync(target)));
  });

  it('atomically publishes new pins only for 9/9 passing results', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pin-unit-'));
    const target = path.join(directory, 'last-known-good.json');
    fs.writeFileSync(target, '{"baseline":true}\n');
    const pins = { schema_version: 1, source_run_id: 'successful-run' };
    assert.strictEqual(ratchetIfAllPassed({
      results: Array.from({ length: 9 }, () => ({ status: 'passed' })),
      expectedCount: 9,
      targetPath: target,
      pins
    }), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), pins);
    assert.deepStrictEqual(
      fs.readdirSync(directory).sort(),
      ['last-known-good.json'],
      'Atomic publication left a temporary file behind'
    );
  });

  it('writes newline-terminated stable JSON', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-json-unit-'));
    const target = path.join(directory, 'manifest.json');
    atomicWriteJson(target, { ok: true });
    assert(fs.readFileSync(target, 'utf8').endsWith('\n'));
  });

  it('restores baseline bytes if pin publication throws after touching the target', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pin-unit-'));
    const target = path.join(directory, 'last-known-good.json');
    const baseline = Buffer.from('{"baseline":true}\n');
    fs.writeFileSync(target, baseline);
    assert.throws(() => ratchetIfAllPassed({
      results: Array.from({ length: 9 }, () => ({ status: 'passed' })),
      expectedCount: 9,
      targetPath: target,
      pins: { baseline: false },
      baselineBytes: baseline,
      writeJson(filePath) {
        fs.writeFileSync(filePath, '{"partially":"advanced"}\n');
        throw new Error('injected ratchet failure');
      }
    }), /injected ratchet failure/);
    assert(baseline.equals(fs.readFileSync(target)));
  });
});
