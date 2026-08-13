import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArtifactStore } from '../artifacts.js';
import { buildSessionMatrix } from '../matrix.js';

function setup() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifact-store-unit-'));
  const seedPinsPath = path.join(artifactDir, 'seed.json');
  fs.writeFileSync(seedPinsPath, '{"baseline":true}\n');
  return { artifactDir, seedPinsPath };
}

describe('agent dev artifact store', () => {
  it('removes stale traces and keeps exactly the nine expected names', () => {
    const files = setup();
    const traceDir = path.join(files.artifactDir, 'traces');
    fs.mkdirSync(traceDir);
    fs.writeFileSync(path.join(traceDir, 'stale.jsonl'), '{}\n');
    const store = new ArtifactStore({ ...files, runId: 'fresh' });
    store.validateTraces();
    assert.deepStrictEqual(
      fs.readdirSync(traceDir).sort(),
      buildSessionMatrix().map((session) => session.traceName).sort()
    );
  });

  it('redacts nested sensitive canaries from JSON and traces', () => {
    const files = setup();
    const store = new ArtifactStore({ ...files, runId: 'secrets' });
    const secret = 'nested-canary-secret';
    store.registerSensitiveValues([secret]);
    store.setPreflight('codex', {
      nested: { stderr: `Authorization: Bearer ${secret}` }
    });
    const session = buildSessionMatrix()[0];
    fs.writeFileSync(store.tracePath(session), `${JSON.stringify({ token: secret })}\n`);
    store.validateTraces();
    const combined = [
      fs.readFileSync(store.manifestPath, 'utf8'),
      fs.readFileSync(store.modelsPath, 'utf8'),
      fs.readFileSync(store.tracePath(session), 'utf8')
    ].join('\n');
    assert(!combined.includes(secret));
    assert(combined.includes('[REDACTED]'));
  });

  it('redacts registered values that require JSON escaping', () => {
    const files = setup();
    const store = new ArtifactStore({ ...files, runId: 'escaped-secrets' });
    const secret = 'quoted"secret\\value';
    store.registerSensitiveValues([secret]);
    const session = buildSessionMatrix()[0];
    fs.writeFileSync(store.tracePath(session), `${JSON.stringify({ nested: { secret } })}\n`);
    store.validateTraces();
    const decoded = JSON.parse(fs.readFileSync(store.tracePath(session), 'utf8'));
    assert.strictEqual(decoded.nested.secret, '[REDACTED]');
  });

  it('rejects malformed JSON in a failed-run trace', () => {
    const files = setup();
    const store = new ArtifactStore({ ...files, runId: 'invalid' });
    fs.writeFileSync(store.tracePath(buildSessionMatrix()[0]), 'not-json\n');
    assert.throws(() => store.validateTraces(), /is not valid JSON/);
  });
});
