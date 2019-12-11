import _ from 'lodash';
var W3CWebSocket = require('websocket').w3cwebsocket;

/**
 * Class which fires and manages a websocket connection to the server. Copied from and derived from the uclusion web ui code
 */
class WebSocketRunner {
    constructor(config) {
        this.wsUrl = config.wsUrl;
        this.reconnectInterval = config.reconnectInterval;
        this.subscribeQueue = [];
        this.messageHanders = [];
    }

    getMessageHandler() {
        const handler = (event) => {
            //console.log(event);
            const payload = JSON.parse(event.data);
            //we're going to filter the messagehandlers at each run
            //and if they return true assume they want to go away
            this.messageHanders = this.messageHanders.filter(messageHandler => !messageHandler(payload));
        };
        return handler.bind(this);
    }

    /**
     * Subscribes the given user id to the subscriptions described in the subscriptions object
     * subscriptions is an object of a form similar to
     * @param idToken the identity token to subscribe too
     */
    subscribe(idToken) {
        const action = { action: 'subscribe', identity : idToken };
        // push the action onto the subscribe queue so if we reconnect we'll track it
        this.subscribeQueue.push(action);
        // if socket is open, just go ahead and send it
        if (this.socket.readyState === this.socket.OPEN) {
            const actionString = JSON.stringify(action);
            this.socket.send(actionString);
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
            setTimeout(runner.connect.bind(runner), runner.reconnectInterval);
        };
        return connectFunc.bind(this);
    }

    // dead stupid version without good error handling, we'll improve later,
    connect() {
        this.socket = new W3CWebSocket(this.wsUrl);
        this.socket.onopen = this.onOpenFactory();
        this.socket.onmessage = this.getMessageHandler();
        // make us retry
        this.socket.onclose = this.onCloseFactory();
    }

    /** Waits for a received message matching the signature passed in
     *
     * @param signature an object of key/value pairs we'll wait for
     * @return A promise that resolves if the message is received within timeout milliseconds,
     * otherwise rejects
     */
    waitForReceivedMessage(signature){
        return this.waitForReceivedMessages([signature]).then((responses) => responses[0]);
    }

    /** Waits for a received messages matching the signature passed in
     *
     * @param signatures an array of object of key/value pairs we'll wait for
     * @return A promise that resolves if the message is received within timeout milliseconds,
     * otherwise rejects
     */
    waitForReceivedMessages(signatures){
        console.log("Waiting on message signatures:");
        console.log(signatures);

        const promises = signatures.map(signature => {
            return new Promise((resolve, reject) => {
                //     const timeoutHandler = setTimeout(() => { reject(signature) }, timeout);
                this.messageHanders.push((payload) => {
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
                        //            clearTimeout(timeoutHandler);
                        resolve(payload);
                        return true;
                    }
                    return false;
                });
            });
        });
        return Promise.all(promises);
    }

    terminate(){
        // kill the reconnect handler and close the socket
        this.socket.onclose = (event) => {};
        this.socket.close();
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
