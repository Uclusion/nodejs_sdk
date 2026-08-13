import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalMarketSignature,
  cleanupFailedFixture,
  deliverFixturePoke,
  deleteIntegrationTestMarket,
  DevFixtureFactory,
  parseDevCredentials
} from '../devFixture.js';

describe('agent dev fixture lifecycle', () => {
  it('requires the JSON UCLUSION_DEV_CREDENTIALS contract', () => {
    assert.deepStrictEqual(parseDevCredentials({
      UCLUSION_DEV_CREDENTIALS: '{"username":"dev@example.com","password":"secret"}'
    }), {
      raw: '{"username":"dev@example.com","password":"secret"}',
      username: 'dev@example.com',
      password: 'secret'
    });
    assert.throws(() => parseDevCredentials({}), /must be JSON/);
    assert.throws(() => parseDevCredentials({ UCLUSION_DEV_CREDENTIALS: '{}' }), /username/);
  });

  it('invokes only the guarded integration-test deletion Lambda contract', async () => {
    let parameters;
    await deleteIntegrationTestMarket('market-exact', {
      lambdaFactory: () => ({
        invoke(value) {
          parameters = value;
          return {
            promise: async () => ({
              StatusCode: 200,
              Payload: Buffer.from(JSON.stringify({
                statusCode: 200,
                body: JSON.stringify({ success_message: 'Market deleted' })
              }))
            })
          };
        }
      })
    });
    assert.strictEqual(parameters.FunctionName, 'uclusion-markets-dev-markets_delete');
    assert.deepStrictEqual(JSON.parse(parameters.Payload), {
      capability: { role: 'Machine', is_admin: true, type: 'market', id: 'market-exact' }
    });
  });

  it('retries every still-active market during factory close', async () => {
    const deleted = [];
    const factory = new DevFixtureFactory({
      webUiRoot: '/unused',
      runId: 'cleanup',
      env: {
        UCLUSION_DEV_CREDENTIALS: '{"username":"dev@example.com","password":"secret"}'
      },
      deleteMarket: async (marketId) => { deleted.push(marketId); }
    });
    factory.activeMarkets.add('market-one');
    factory.activeMarkets.add('market-two');
    await factory.close();
    assert.deepStrictEqual(deleted.sort(), ['market-one', 'market-two']);
    assert.strictEqual(factory.activeMarkets.size, 0);
  });

  it('tracks and deletes a created market before rejecting an unexpected subtype', async () => {
    const deleted = [];
    const factory = new DevFixtureFactory({
      webUiRoot: '/unused',
      runId: 'wrong-subtype',
      env: {
        UCLUSION_DEV_CREDENTIALS: '{"username":"dev@example.com","password":"secret"}'
      },
      deleteMarket: async (marketId) => { deleted.push(marketId); }
    });
    factory.accountClient = {
      markets: {
        createMarket: async () => ({
          market: {
            id: 'market-wrong-subtype',
            invite_capability: 'invite-secret',
            market_sub_type: 'PRODUCTION'
          }
        })
      }
    };

    await assert.rejects(
      factory.create({ client: 'codex', scenario: 'session-start' }),
      /not marked for guarded deletion/
    );
    assert.deepStrictEqual(deleted, ['market-wrong-subtype']);
    assert.strictEqual(factory.activeMarkets.size, 0);
    assert(factory.sensitiveValues().includes('invite-secret'));
  });

  it('builds a fixture-only listener launcher that signals after the real arm call', () => {
    const source = fs.readFileSync(new URL('../devFixture.js', import.meta.url), 'utf8');
    assert.match(source, /original_arm\(environment, workspace_id, consumer\)/);
    assert.match(source, /os\.replace\(temporary, target\)/);
    assert.match(source, /TEST_AGENT_DEV_LISTENER_READY/);
    assert.doesNotMatch(source, /SELECT 1 FROM poke_consumers/);
    assert.match(source, /module\.enqueue_prompt = enqueue_and_signal/);
    assert.match(source, /TEST_AGENT_DEV_POKE_PERSISTED/);
  });

  it('canonicalizes all market object versions so child mutations change snapshots', () => {
    const before = canonicalMarketSignature({ signatures: [{
      market_id: 'market-one',
      signatures: [{
        type: 'investible',
        object_versions: [{ version: 1, object_id_one: 'job' }]
      }, { type: 'comment', object_versions: [] }]
    }] }, 'market-one');
    const after = canonicalMarketSignature({ signatures: [{
      market_id: 'market-one',
      signatures: [{
        type: 'comment',
        object_versions: [{ object_id_one: 'comment', version: 1 }]
      }, {
        type: 'investible',
        object_versions: [{ object_id_one: 'job', version: 1 }]
      }]
    }] }, 'market-one');
    assert.notDeepStrictEqual(after, before);
  });

  it('attempts every setup cleanup action and aggregates all failures', async () => {
    const attempted = [];
    const setupError = new Error('setup failed');
    await assert.rejects(cleanupFailedFixture({
      setupError,
      marketId: 'market-one',
      fixtureRoot: '/fixture-root',
      pokeSocket: {
        terminate() {
          attempted.push('socket');
          throw new Error('socket failed');
        }
      },
      removeTree() {
        attempted.push('tree');
        throw new Error('tree failed');
      },
      async releaseMarket() {
        attempted.push('market');
        throw new Error('market failed');
      }
    }), (error) => {
      assert(error instanceof AggregateError);
      assert.deepStrictEqual(error.errors.map((entry) => entry.message), [
        'setup failed', 'socket failed', 'tree failed', 'market failed'
      ]);
      return true;
    });
    assert.deepStrictEqual(attempted, ['socket', 'tree', 'market']);
  });

  it('withholds the bare wait release until proxy persistence follows sender receipt',
    async () => {
    let resolveReceipt;
    let resolvePersistence;
    let released = false;
    const delivery = deliverFixturePoke({
      pokeSocket: {
        waitForReceivedMessage() {
          return new Promise((resolve) => { resolveReceipt = resolve; });
        },
        pokeAI() {}
      },
      marketToken: 'market-token',
      message: 'Start J-race-1',
      pokePersisted: '/persisted',
      waitForPersisted: () => new Promise((resolve) => { resolvePersistence = resolve; }),
      waitGateRelease: '/release',
      writeRelease() { released = true; }
    });
    resolveReceipt();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(released, false,
      'Sender receipt must not release wait before proxy persistence');
    resolvePersistence();
    await delivery;
    assert.strictEqual(released, true);
  });
});
