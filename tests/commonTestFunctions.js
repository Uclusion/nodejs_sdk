import assert from 'assert';

export const checkStages = (expectedNames, stageList) => {
    assert(expectedNames.length === stageList.length, 'We received the wrong number of stages');
    for (const stage of stageList){
        assert(expectedNames.includes(stage.name), 'We received an unexpected stage ' + stage.name)
    }
};

export const verifyExpectedMessages = (messageQueue, expectedWebsocketMessages) => {
    //console.log(expectedWebsocketMessages);
    //console.log(messageQueue);
    for (const expected of expectedWebsocketMessages){
        //console.log("Looking for message");
        //console.log(expected);
        const found = messageQueue.find((element) => {
            //console.log("Processing element");
            //console.log(element);
            const event_type_match = element.event_type === expected.event_type;
            //console.log("Event Type Match: " + event_type_match);
            const object_id_match = element.object_id === expected.object_id;
            //console.log("Object Id Match: " + object_id_match);
            return event_type_match && object_id_match;
        });
        assert(found, 'Did not find message on websocket we were expecting');
    }
};


/**
 * This array equals compares arrays based on contents. That is
 * if arr1 intersection arr2 == [] then we are equal, otherwise
 * we're not
 * @param arr1
 * @param arr2
 * @returns {boolean}
 * @private
 */
export const arrayEquals = (arr1, arr2) => {
    if(arr1 === undefined && arr2 !== undefined){
        return false;
    }
    if(arr2 === undefined && arr1 != undefined){
        return false;
    }
    /// TOOD: convert this to a set implementation
    if (arr1.length !== arr2.length)
        return false;
    arr1.forEach(function (e) {
        if (arr2.indexOf(e) < 0)
            return false;
    });
    return true;
};


export function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    })
}

// Logs into the CLI/MCP endpoint with the user's secret the same way uclusionCLI.py does
export async function mcpLogin(configuration, marketClient, marketId) {
    const secretUser = await marketClient.users.getSecret();
    const response = await fetch(configuration.baseURL.replace('https://', 'https://sso.') + '/cli', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            market_id: marketId,
            client_id: `${secretUser.external_id}_${secretUser.account_id}`,
            client_secret: secretUser.client_secret
        })
    });
    assert(response.ok, `CLI login failed with status ${response.status}`);
    const { uclusion_token: uclusionToken } = await response.json();
    return uclusionToken;
}

// MCP is just a post - JSON-RPC tools/call against the investibles mcp endpoint
export async function mcpCall(configuration, uclusionToken, toolName, args) {
    const response = await fetch(configuration.baseURL.replace('https://', 'https://investibles.') + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: uclusionToken },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: toolName, arguments: args }
        })
    });
    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        assert.fail(`MCP ${toolName} failed with status ${response.status}: ${errorBody}`);
    }
    const result = await response.json();
    return JSON.stringify(result);
}