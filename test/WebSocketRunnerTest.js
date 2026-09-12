import assert from 'assert';
import {WebSocketRunner} from '../src/WebSocketRunner.js';

describe('WebSocketRunner', () => {
    it('does not match unequal primitive signature values', () => {
        const runner = new WebSocketRunner({});

        assert.strictEqual(runner.checkPayload({event_type: 'comment', version: 1},
            {event_type: 'comment', version: 2}), false);
    });

    it('queues a message no active handler consumed', async () => {
        const runner = new WebSocketRunner({});
        const deliver = runner.getMessageHandler();
        // An unrelated wait is deliberately left in flight. Before 490bd29 its mere
        // presence stopped the runner buffering anything it did not itself match, so the
        // payload below was offered to this handler, refused, and then dropped with
        // nothing retaining it. The later wait then had nothing to find and timed out.
        const unrelated = runner.waitForReceivedMessages([{event_type: 'stage'}], 50);

        deliver({data: JSON.stringify({event_type: 'comment', version: 7})});

        const [received] = await runner.waitForReceivedMessages(
            [{event_type: 'comment', version: 7}], 50);
        assert.strictEqual(received.event_type, 'comment');
        assert.strictEqual(received.version, 7);
        // Doubles as proof the unrelated wait really was open and really was unsatisfied,
        // and leaves no pending timer to hold mocha open after the case ends.
        await assert.rejects(unrelated, (error) => error.code === 'WEBSOCKET_MESSAGE_TIMEOUT');
    });

    it('queues a message that arrives with no wait in flight', async () => {
        const runner = new WebSocketRunner({});
        const deliver = runner.getMessageHandler();
        // 490bd29 replaced the buffering condition outright rather than extending it, so
        // the path that already worked is as newly written as the one it fixed.
        deliver({data: JSON.stringify({event_type: 'investible', version: 3})});

        const [received] = await runner.waitForReceivedMessages(
            [{event_type: 'investible', version: 3}], 50);
        assert.strictEqual(received.event_type, 'investible');
        assert.strictEqual(received.version, 3);
    });
});
