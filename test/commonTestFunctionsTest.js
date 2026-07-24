import assert from 'assert';
import {pollFor} from '../tests/commonTestFunctions.js';

describe('common test functions', () => {
    describe('pollFor', () => {
        it('retries transient fetch errors', async () => {
            let attempts = 0;

            const result = await pollFor(() => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('not ready');
                }
                return attempts;
            }, (value) => value === 2, 2, 0);

            assert.strictEqual(result, 2);
        });

        it('throws when every fetch attempt fails', async () => {
            await assert.rejects(
                () => pollFor(() => {
                    throw new Error('still unavailable');
                }, () => false, 2, 0),
                /still unavailable/);
        });

        it('returns the final state when the predicate never matches', async () => {
            let value = 0;

            const result = await pollFor(() => {
                value += 1;
                return value;
            }, () => false, 3, 0);

            assert.strictEqual(result, 3);
        });
    });
});
