import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createPendingMarketCleanup,
  runAfterPendingMarketCleanup
} from '../pendingMarketCleanup.js';

const JOURNAL_DIRECTORY = 'pending-market-cleanup';

describe('agent dev pending market cleanup', () => {
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function setup(deleteMarket) {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-market-cleanup-'));
    temporaryDirectories.push(artifactDir);
    return {
      artifactDir,
      journalDirectory: path.join(artifactDir, JOURNAL_DIRECTORY),
      cleanup: createPendingMarketCleanup({ artifactDir, deleteMarket })
    };
  }

  it('durably registers an exact id and replays it immediately on the next startup', async () => {
    const { artifactDir, cleanup, journalDirectory } = setup(async () => {});
    cleanup.registerMarket('market-one');
    const files = fs.readdirSync(journalDirectory);
    assert.strictEqual(files.length, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(
      path.join(journalDirectory, files[0]), 'utf8'
    )), {
      schema_version: 1,
      market_id: 'market-one'
    });

    const deleted = [];
    const second = createPendingMarketCleanup({
      artifactDir,
      deleteMarket: async (marketId) => { deleted.push(marketId); }
    });
    await second.replay();
    assert.deepStrictEqual(deleted, ['market-one']);
    assert.deepStrictEqual(fs.readdirSync(journalDirectory), []);
  });

  it('keeps the durable entry until guarded deletion succeeds', async () => {
    let completeDeletion;
    const remoteDeletion = new Promise((resolve) => { completeDeletion = resolve; });
    const { cleanup, journalDirectory } = setup(() => remoteDeletion);
    cleanup.registerMarket('market-one');

    const deletion = cleanup.deleteMarket('market-one');
    assert.strictEqual(fs.readdirSync(journalDirectory).length, 1);
    completeDeletion();
    await deletion;
    assert.deepStrictEqual(fs.readdirSync(journalDirectory), []);
  });

  it('retains a failed deletion for a later invocation', async () => {
    const { artifactDir, cleanup, journalDirectory } = setup(async () => {
      throw new Error('guarded deletion failed');
    });
    cleanup.registerMarket('market-one');

    await assert.rejects(cleanup.replay(), (error) => {
      assert(error instanceof AggregateError);
      assert.strictEqual(error.errors.length, 1);
      assert.match(error.errors[0].message, /guarded deletion failed/);
      return true;
    });
    assert.strictEqual(fs.readdirSync(journalDirectory).length, 1);

    const retried = [];
    await createPendingMarketCleanup({
      artifactDir,
      deleteMarket: async (marketId) => { retried.push(marketId); }
    }).replay();
    assert.deepStrictEqual(retried, ['market-one']);
    assert.deepStrictEqual(fs.readdirSync(journalDirectory), []);
  });

  it('attempts every valid record while retaining and reporting all failures', async () => {
    const attempted = [];
    const { cleanup, journalDirectory } = setup(async (marketId) => {
      attempted.push(marketId);
      if (marketId === 'market-failed') {
        throw new Error('remote failure');
      }
    });
    cleanup.registerMarket('market-success');
    cleanup.registerMarket('market-failed');
    fs.writeFileSync(path.join(journalDirectory, 'malformed.json'), '{not json');

    await assert.rejects(cleanup.replay(), (error) => {
      assert(error instanceof AggregateError);
      assert.strictEqual(error.errors.length, 2);
      assert(error.errors.some((entry) => entry.message.includes('remote failure')));
      assert(error.errors.some((entry) => entry.message.includes('malformed.json')));
      return true;
    });
    assert.deepStrictEqual(attempted.sort(), ['market-failed', 'market-success']);
    const remaining = fs.readdirSync(journalDirectory);
    assert.strictEqual(remaining.length, 2);
    assert(remaining.includes('malformed.json'));
    assert(remaining.some((file) => {
      if (file === 'malformed.json') {
        return false;
      }
      return JSON.parse(fs.readFileSync(path.join(journalDirectory, file), 'utf8'))
        .market_id === 'market-failed';
    }));
  });

  it('stops catalog startup when replay does not clear every record', async () => {
    let started = false;
    await assert.rejects(runAfterPendingMarketCleanup({
      replay: async () => { throw new Error('cleanup debt remains'); }
    }, async () => {
      started = true;
    }), /cleanup debt remains/);
    assert.strictEqual(started, false);

    const order = [];
    const result = await runAfterPendingMarketCleanup({
      replay: async () => { order.push('replay'); }
    }, async () => {
      order.push('catalog');
      return 'passed';
    });
    assert.strictEqual(result, 'passed');
    assert.deepStrictEqual(order, ['replay', 'catalog']);
  });
});
