import assert from 'assert';
import http from 'http';
import websocket from 'websocket';
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

    describe('heartbeat recovery', () => {
        let server;
        let websocketServer;
        let runner;

        beforeEach(async () => {
            server = http.createServer();
            websocketServer = new websocket.server({httpServer: server});
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            runner = new WebSocketRunner({
                wsUrl: `ws://127.0.0.1:${server.address().port}`,
                keepaliveMilliseconds: 40,
                reconnectInterval: 5,
            });
        });

        afterEach(async () => {
            runner.terminate();
            websocketServer.connections.slice().forEach((connection) => connection.drop());
            websocketServer.shutDown();
            await new Promise((resolve) => server.close(resolve));
        });

        it('recovers a pending push wait by reconnecting and replaying its authenticated subscription', async () => {
            let connectionCount = 0;
            const subscriptions = [];
            const subscription = {
                action: 'subscribe', identity: 'local-test-identity',
                is_ai: true, owned_short_code_ids: ['J-local-1'],
            };
            const push = {event_type: 'market_investible', object_id: 'recovered-job'};
            websocketServer.on('request', (request) => {
                const connection = request.accept();
                const connectionNumber = ++connectionCount;
                connection.on('message', ({utf8Data}) => {
                    if (utf8Data === 'ping') {
                        // The first transport stays open after losing its subscription.
                        // Without its subscription, the server does not return a pong.
                        if (connectionNumber > 1) {
                            connection.sendUTF(JSON.stringify({event_type: 'pong'}));
                        }
                        return;
                    }
                    subscriptions.push(JSON.parse(utf8Data));
                    if (connectionNumber > 1) {
                        connection.sendUTF(JSON.stringify(push));
                    }
                });
            });

            const pendingPush = runner.waitForReceivedMessage(push, 1000);
            runner.connect();
            runner.subscribe(subscription.identity, true, subscription.owned_short_code_ids);

            assert.deepStrictEqual(await pendingPush, push);
            assert.strictEqual(connectionCount, 2);
            assert.deepStrictEqual(subscriptions, [subscription, subscription]);
        });

        it('keeps a healthy connection when pongs or ordinary pushes answer its heartbeats', async () => {
            let connectionCount = 0;
            let pingCount = 0;
            const completed = {event_type: 'heartbeat-test-complete'};
            websocketServer.on('request', (request) => {
                const connection = request.accept();
                connectionCount += 1;
                connection.on('message', ({utf8Data}) => {
                    if (utf8Data !== 'ping') {
                        return;
                    }
                    pingCount += 1;
                    connection.sendUTF(JSON.stringify({
                        event_type: pingCount % 2 ? 'pong' : 'comment',
                    }));
                    if (pingCount === 5) {
                        connection.sendUTF(JSON.stringify(completed));
                    }
                });
            });

            const pendingCompletion = runner.waitForReceivedMessage(completed, 1000);
            runner.connect();
            await pendingCompletion;

            assert.strictEqual(connectionCount, 1);
            assert.strictEqual(pingCount, 5);
        });
    });
});
