import assert from 'assert';

export const checkStages = (expectedNames, stageList) => {
    assert(expectedNames.length === stageList.length, 'We received the wrong number of stages');
    for (const stage of stageList){
        assert(expectedNames.includes(stage.name), 'We received an unexpected stage ' + stage.name)
    }
};

export const verifyStage = (expected, received) => {
    assert(expected.name === received.name, 'Stage has wrong name');
    assert(expected.appears_in_market_summary === received.appears_in_market_summary,
        'Stage has wrong appears in market summary');
    assert(expected.allows_investment === received.allows_investment, 'Stage has wrong allows investment');
    assert(expected.visible_to_roles.length === received.visible_to_roles.length);
    for(const role of expected.visible_to_roles){
        assert(received.visible_to_roles.includes(role), "Sshould have included role " + role);
    }
    assert(expected.allows_refunds === received.allows_refunds, 'Stage has wrong allows refunds');
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