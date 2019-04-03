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
    assert(expected.allows_editing === received.allows_refunds, 'Stage has wrong allows editing');
};