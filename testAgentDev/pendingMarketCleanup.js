import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { atomicWriteJson } from './atomicJson.js';

const JOURNAL_DIRECTORY = 'pending-market-cleanup';
const RECORD_SCHEMA_VERSION = 1;

function requireMarketId(marketId) {
  if (typeof marketId !== 'string' || !marketId || marketId.trim() !== marketId) {
    throw new TypeError('Pending market cleanup requires an exact non-empty market id');
  }
  return marketId;
}

function recordPath(journalDirectory, marketId) {
  const digest = createHash('sha256').update(requireMarketId(marketId)).digest('hex');
  return path.join(journalDirectory, `${digest}.json`);
}

function readRecord(filePath) {
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!record || record.schema_version !== RECORD_SCHEMA_VERSION) {
    throw new Error(`expected schema_version ${RECORD_SCHEMA_VERSION}`);
  }
  requireMarketId(record.market_id);
  return record.market_id;
}

function recordFailure(filePath, error, marketId) {
  return new Error(
    `Pending market cleanup record ${path.basename(filePath)}` +
      `${marketId ? ` for ${marketId}` : ''} failed: ${error.message}`,
    { cause: error }
  );
}

export function createPendingMarketCleanup({ artifactDir, deleteMarket }) {
  if (typeof deleteMarket !== 'function') {
    throw new TypeError('Pending market cleanup requires a guarded delete function');
  }
  const journalDirectory = path.join(path.resolve(artifactDir), JOURNAL_DIRECTORY);

  function registerMarket(marketId) {
    const targetPath = recordPath(journalDirectory, marketId);
    atomicWriteJson(targetPath, {
      schema_version: RECORD_SCHEMA_VERSION,
      market_id: marketId
    });
  }

  async function deleteRecord(marketId, filePath) {
    await deleteMarket(marketId);
    fs.rmSync(filePath, { force: true });
  }

  async function deleteTrackedMarket(marketId) {
    const targetPath = recordPath(journalDirectory, marketId);
    await deleteRecord(marketId, targetPath);
  }

  async function replay() {
    let entries;
    try {
      entries = fs.readdirSync(journalDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    const failures = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(journalDirectory, entry.name);
      if (!entry.isFile()) {
        failures.push(recordFailure(filePath, new Error('expected a regular JSON file')));
        continue;
      }
      let marketId;
      try {
        marketId = readRecord(filePath);
        await deleteRecord(marketId, filePath);
      } catch (error) {
        failures.push(recordFailure(filePath, error, marketId));
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `${failures.length} pending market cleanup record(s) require attention`
      );
    }
  }

  return {
    registerMarket,
    deleteMarket: deleteTrackedMarket,
    replay
  };
}

export async function runAfterPendingMarketCleanup(marketCleanup, runCatalog) {
  await marketCleanup.replay();
  return runCatalog();
}
