import assert from 'assert';
import { serializeError } from '../errors.js';

describe('agent dev error serialization', () => {
  it('allowlists diagnostics and drops nested transport credentials', () => {
    const error = new Error('request failed');
    error.code = 'E_REQUEST';
    error.config = {
      headers: { Authorization: 'Bearer nested-canary-secret' },
      password: 'nested-canary-secret'
    };
    error.response = { data: { token: 'nested-canary-secret' } };
    const serialized = serializeError(error);
    assert.deepStrictEqual(Object.keys(serialized).sort(), ['code', 'message', 'name', 'stack']);
    assert(!JSON.stringify(serialized).includes('nested-canary-secret'));
  });

  it('preserves allowlisted causes and aggregate failures', () => {
    const first = new Error('first');
    first.code = 401;
    const aggregate = new AggregateError([first, new Error('second')], 'both');
    const serialized = serializeError(aggregate);
    assert.strictEqual(serialized.errors.length, 2);
    assert.strictEqual(serialized.errors[0].code, 401);
  });
});
