import assert from 'assert';
import {WebSocketRunner} from '../src/WebSocketRunner.js';

describe('WebSocketRunner', () => {
    it('does not match unequal primitive signature values', () => {
        const runner = new WebSocketRunner({});

        assert.strictEqual(runner.checkPayload({event_type: 'comment', version: 1},
            {event_type: 'comment', version: 2}), false);
    });
});
