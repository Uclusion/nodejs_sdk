import _ from 'lodash';
import websocket from 'websocket';

const W3CWebSocket = websocket.w3cwebsocket;

/**
 * Class which fires and manages a websocket connection to the server. Copied from and derived from the uclusion web ui code
 */
class WebSocketRunner {
    constructor(config) {
        this.wsUrl = config.wsUrl;
        this.reconnectInterval = config.reconnectInterval;
        this.subscribeQueue = [];
        this.messageHanders = [];
        this.previouslyQueued = [];
        this.reconnectTimeout = undefined;
        this.terminated = false;
    }

    getMessageHandler() {
        const handler = (event) => {
            //console.log(event);
            const payload = JSON.parse(event.data);
            if (this.messageHanders.length === 0) {
                // console.log("Queuing for later:");
                // console.log(payload);
                // No active message handler so try to avoid dropping a message
                this.previouslyQueued.push(payload);
            }
            //we're going to filter the messagehandlers at each run
            //and if they return true assume they want to go away
            this.messageHanders = this.messageHanders.filter(messageHandler => !messageHandler(payload));
        };
        return handler.bind(this);
    }

    /**
     * Subscribes the given user id to the subscriptions described in the subscriptions object
     * subscriptions is an object of a form similar to
     * @param idToken the identity token to subscribe to
     * @param isAI whether to subscribe to the token's market as an AI client
     */
    subscribe(idToken, isAI = false) {
        const action = { action: 'subscribe', identity : idToken };
        if (isAI) {
            action.is_ai = true;
        }
        // push the action onto the subscribe queue so if we reconnect we'll track it
        this.subscribeQueue.push(action);
        // if socket is open, just go ahead and send it
        if (this.socket.readyState === this.socket.OPEN) {
            this.send(action);
        }
        // compact the queue to remove duplicates
        const compacted = _.uniqWith(this.subscribeQueue, _.isEqual);
        this.subscribeQueue = compacted;
  //      console.debug('Subscribe queue at end of subscribe:', JSON.stringify(this.subscribeQueue));
    }

    onOpenFactory() {
        // we have to assign queue this to prevent the handler's
        // this from being retargeted to the websocket
        const queue = this.subscribeQueue;
        //console.debug('Subcribing to:', queue);
        const factory = (event) => {
          //  console.debug('Here in open factory with queue:', JSON.stringify(queue));
          //  console.debug('My socket is:', this.socket);
            queue.forEach(action => {
                const actionString = JSON.stringify(action);
                //console.debug('Sending to my socket:', actionString);
                this.socket.send(actionString);
            });
            // we're not emptying the queue because we might need it on reconnect
        };
        return factory.bind(this);
    }

    onCloseFactory() {
        const runner = this;
        const connectFunc = function (event) {
            //console.debug('Web socket closed. Reopening in:', runner.reconnectInterval);
            if (!runner.terminated) {
                runner.reconnectTimeout = setTimeout(runner.connect.bind(runner), runner.reconnectInterval);
            }
        };
        return connectFunc.bind(this);
    }

    // dead stupid version without good error handling, we'll improve later,
    connect() {
        this.terminated = false;
        this.socket = new W3CWebSocket(this.wsUrl);
        this.socket.onopen = this.onOpenFactory();
        this.socket.onmessage = this.getMessageHandler();
        // make us retry
        this.socket.onclose = this.onCloseFactory();
    }

    /**
     * Waits until the websocket is open without replacing its open handler.
     *
     * @param timeoutMilliseconds maximum time to wait
     * @return a promise that resolves once the socket is open
     */
    waitForOpen(timeoutMilliseconds = 30000) {
        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            const checkReadyState = () => {
                if (this.socket && this.socket.readyState === this.socket.OPEN) {
                    resolve();
                    return;
                }
                if (this.terminated) {
                    reject(new Error('Websocket terminated before it opened'));
                    return;
                }
                if (Date.now() - startedAt >= timeoutMilliseconds) {
                    reject(new Error(`Timed out after ${timeoutMilliseconds}ms waiting for websocket to open`));
                    return;
                }
                setTimeout(checkReadyState, 50);
            };
            checkReadyState();
        });
    }

    /**
     * Sends an action without adding it to the reconnecting subscription queue.
     *
     * @param action an action object, or a raw string such as ping
     */
    send(action) {
        if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
            throw new Error('Cannot send because websocket is not open');
        }
        this.socket.send(typeof action === 'string' ? action : JSON.stringify(action));
    }

    pokeAI(idToken, message) {
        this.send({ action: 'poke_ai', identity: idToken, message });
    }

    /** Waits for a received message matching the signature passed in
     *
     * @param signature an object of key/value pairs we'll wait for
     * @param timeoutMilliseconds optional maximum time to wait
     * @return A promise that resolves if the message is received within timeout milliseconds,
     * otherwise rejects
     */
    waitForReceivedMessage(signature, timeoutMilliseconds){
        return this.waitForReceivedMessages([signature], timeoutMilliseconds)
            .then((responses) => responses[0]);
    }

    checkPayload(payload, signature) {
        console.log("Received payload for matching:");
        console.log(payload);
        let stillMatching = true;
        console.log("Testing message against signature:");
        console.log(signature);
        for(const key of Object.keys(signature)){
            stillMatching &= (payload[key] === signature[key] || isSubsetEquivalent(payload[key], signature[key]));
        }
        if (stillMatching) {
            console.log("Found match");
            return true;
        }
        return false;
    }

    /** Waits for a received messages matching the signature passed in
     *
     * @param signatures an array of object of key/value pairs we'll wait for
     * @param timeoutMilliseconds optional maximum time to wait
     * @return A promise that resolves if the message is received within timeout milliseconds,
     * otherwise rejects
     */
    waitForReceivedMessages(signatures, timeoutMilliseconds){
        console.log("Waiting on message signatures:");
        console.log(signatures);
        const promises = signatures.map(signature => {
            const queuedIndex = this.previouslyQueued.findIndex((payload) =>
                this.checkPayload(payload, signature));
            if (queuedIndex >= 0) {
                return Promise.resolve(this.previouslyQueued.splice(queuedIndex, 1)[0]);
            }
            return new Promise((resolve, reject) => {
                let timeout;
                const messageHandler = (payload) => {
                    if (this.checkPayload(payload, signature)) {
                        clearTimeout(timeout);
                        resolve(payload);
                        return true;
                    }
                    return false;
                };
                this.messageHanders.push(messageHandler);
                if (timeoutMilliseconds !== undefined) {
                    timeout = setTimeout(() => {
                        this.messageHanders = this.messageHanders.filter((handler) =>
                            handler !== messageHandler);
                        const error = new Error(
                            `Timed out after ${timeoutMilliseconds}ms waiting for websocket message ` +
                            JSON.stringify(signature));
                        error.code = 'WEBSOCKET_MESSAGE_TIMEOUT';
                        reject(error);
                    }, timeoutMilliseconds);
                }
            });
        });
        return Promise.all(promises);
    }

    terminate(){
        // kill the reconnect handler and close the socket
        this.terminated = true;
        clearTimeout(this.reconnectTimeout);
        if (this.socket) {
            this.socket.onclose = (event) => {};
            this.socket.close();
        }
    }
}

function isSubsetEquivalent(payload, signature) {
    if ((!payload && signature) || (!signature && payload)) {
        return false
    }
    for(const key of Object.keys(signature)){
        if (payload[key] !== signature[key]) {
            return false;
        }
    }
    return true;
}

export { WebSocketRunner };
