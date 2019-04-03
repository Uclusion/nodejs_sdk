import assert from 'assert';

export const checkStages = (expectedNames, stageList) => {
    assert(expectedNames.length === stageList.length, 'We received the wrong number of stages');
    for (const stage of stageList){
        assert(expectedNames.includes(stage.name), 'We received an unexpected stage ' + stage.name)
    }
};