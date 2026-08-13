import assert from 'assert';
import { buildSessionMatrix, CLIENTS, SCENARIOS } from '../matrix.js';

describe('agent dev session matrix', () => {
  it('contains exactly one fresh logical session for every client/scenario pair', () => {
    const matrix = buildSessionMatrix();
    assert.strictEqual(matrix.length, 9);
    assert.strictEqual(new Set(matrix.map((entry) => entry.key)).size, 9);
    assert.deepStrictEqual([...new Set(matrix.map((entry) => entry.client))], CLIENTS);
    assert.deepStrictEqual(
      [...new Set(matrix.map((entry) => entry.scenario))],
      SCENARIOS.map((entry) => entry.id)
    );
    assert.strictEqual(new Set(matrix.map((entry) => entry.traceName)).size, 9);
  });
});

