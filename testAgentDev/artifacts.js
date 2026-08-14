import fs from 'fs';
import path from 'path';
import { atomicWriteJson } from './atomicJson.js';
import { buildSessionMatrix } from './matrix.js';

const REDACTED = '[REDACTED]';

function makePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function makePrivateFile(filePath) {
  fs.chmodSync(filePath, 0o600);
}

function sensitiveStrings(values) {
  return [...new Set((values || [])
    .filter((value) => typeof value === 'string' && value.length >= 4))]
    .sort((left, right) => right.length - left.length);
}

function redactText(value, secrets) {
  let result = String(value);
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

function redactValue(value, secrets, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, secrets, seen));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    redactValue(entry, secrets, seen)
  ]));
}

function assertNoSecret(bytes, secrets, label) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const found = secrets.find((secret) => text.includes(secret));
  if (found) {
    throw new Error(`${label} still contains a registered sensitive value`);
  }
}

export class ArtifactStore {
  constructor({
    artifactDir,
    seedPinsPath,
    runId,
    sessions = buildSessionMatrix(),
    catalog = 'triggers'
  }) {
    this.artifactDir = artifactDir;
    this.runId = runId;
    this.sessions = [...sessions];
    if (new Set(this.sessions.map((session) => session.key)).size !== this.sessions.length) {
      throw new Error('Artifact session keys must be unique');
    }
    if (new Set(this.sessions.map((session) => session.traceName)).size !== this.sessions.length) {
      throw new Error('Artifact trace names must be unique');
    }
    this.traceDir = path.join(artifactDir, 'traces');
    this.manifestPath = path.join(artifactDir, 'manifest.json');
    this.modelsPath = path.join(artifactDir, 'resolved-models.json');
    this.pinsPath = path.join(artifactDir, 'last-known-good.json');
    makePrivateDirectory(this.artifactDir);
    const relativeTraceDir = path.relative(path.resolve(this.artifactDir), path.resolve(this.traceDir));
    if (!relativeTraceDir || relativeTraceDir.startsWith('..') || path.isAbsolute(relativeTraceDir)) {
      throw new Error(`Refusing unsafe trace cleanup target ${this.traceDir}`);
    }
    fs.rmSync(this.traceDir, { recursive: true, force: true });
    makePrivateDirectory(this.traceDir);
    if (!fs.existsSync(this.pinsPath)) {
      fs.copyFileSync(seedPinsPath, this.pinsPath, fs.constants.COPYFILE_EXCL);
    }
    this.baselinePinBytes = fs.readFileSync(this.pinsPath);
    this.manifest = {
      schema_version: 1,
      run_id: runId,
      environment: 'dev',
      catalog,
      started_at: new Date().toISOString(),
      status: 'running',
      source_package: null,
      preflight: {},
      sessions: {},
      failures: []
    };
    this.models = {
      schema_version: 1,
      run_id: runId,
      complete: false,
      sessions: {}
    };
    this.secrets = [];
    for (const session of this.sessions) {
      const tracePath = path.join(this.traceDir, session.traceName);
      fs.writeFileSync(tracePath, '', { flag: 'w', mode: 0o600 });
      makePrivateFile(tracePath);
      this.manifest.sessions[session.key] = {
        client: session.client,
        scenario: session.scenario,
        status: 'pending',
        trace: `traces/${session.traceName}`
      };
    }
    this.flush();
  }

  tracePath(session) {
    return path.join(this.traceDir, session.traceName);
  }

  flush() {
    atomicWriteJson(this.manifestPath, redactValue(this.manifest, this.secrets));
    atomicWriteJson(this.modelsPath, redactValue(this.models, this.secrets));
    this.assertNoSecrets();
  }

  registerSensitiveValues(values, { flush = true } = {}) {
    this.secrets = sensitiveStrings([...this.secrets, ...(values || [])]);
    if (flush) {
      this.flush();
    }
  }

  sanitizeTrace(tracePath) {
    if (!fs.existsSync(tracePath)) {
      return;
    }
    const text = fs.readFileSync(tracePath, 'utf8');
    const redacted = text.split('\n').map((line) => {
      if (!line.trim()) {
        return line;
      }
      try {
        return JSON.stringify(redactValue(JSON.parse(line), this.secrets));
      } catch (_error) {
        // Keep malformed output structurally unchanged so validateTraces emits
        // the precise line failure, but remove any directly registered value.
        return redactText(line, this.secrets);
      }
    }).join('\n');
    if (redacted !== text) {
      fs.writeFileSync(tracePath, redacted);
    }
  }

  validateTraces() {
    const expected = this.sessions.map((session) => session.traceName).sort();
    const actual = fs.readdirSync(this.traceDir).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Trace directory must contain exactly the planned traces; found ${JSON.stringify(actual)}`
      );
    }
    for (const name of actual) {
      const tracePath = path.join(this.traceDir, name);
      this.sanitizeTrace(tracePath);
      const text = fs.readFileSync(tracePath, 'utf8');
      text.split('\n').forEach((line, index) => {
        if (!line.trim()) {
          return;
        }
        try {
          JSON.parse(line);
        } catch (error) {
          throw new Error(`${name}:${index + 1} is not valid JSON: ${error.message}`);
        }
      });
    }
    this.assertNoSecrets();
  }

  assertNoSecrets() {
    for (const [filePath, label] of [
      [this.manifestPath, 'manifest'],
      [this.modelsPath, 'resolved models']
    ]) {
      if (fs.existsSync(filePath)) {
        assertNoSecret(fs.readFileSync(filePath), this.secrets, label);
      }
    }
    if (fs.existsSync(this.traceDir)) {
      for (const name of fs.readdirSync(this.traceDir)) {
        assertNoSecret(fs.readFileSync(path.join(this.traceDir, name)), this.secrets, name);
      }
    }
  }

  setSourcePackage(sourcePackage) {
    this.manifest.source_package = sourcePackage;
    this.flush();
  }

  setPreflight(client, result) {
    this.manifest.preflight[client] = result;
    this.flush();
  }

  startSession(session, details) {
    this.manifest.sessions[session.key] = {
      ...this.manifest.sessions[session.key],
      ...details,
      status: 'running',
      started_at: new Date().toISOString()
    };
    this.flush();
  }

  finishSession(session, result, modelRecord = null) {
    this.manifest.sessions[session.key] = {
      ...this.manifest.sessions[session.key],
      ...result,
      finished_at: new Date().toISOString()
    };
    if (modelRecord) {
      this.models.sessions[session.key] = modelRecord;
    }
    if (result.status === 'failed' && result.failure) {
      this.manifest.failures.push({ session: session.key, ...result.failure });
    }
    this.flush();
  }

  failPreflight(failure) {
    this.manifest.status = 'failed';
    this.manifest.finished_at = new Date().toISOString();
    this.manifest.failures.push(failure);
    this.models.complete = false;
    this.flush();
  }

  finish(status) {
    this.manifest.status = status;
    this.manifest.finished_at = new Date().toISOString();
    this.models.complete = status === 'passed';
    this.flush();
  }

  assertPinsUnchanged() {
    return this.baselinePinBytes.equals(fs.readFileSync(this.pinsPath));
  }
}
