import assert from 'assert';
import { assertScenario } from '../assertions.js';

const command = '/tmp/probe/uclusion-dev -e dev';
const stableState = Object.freeze({
  ticket_code: 'J-probe-1',
  stage_id: 'doable',
  deleted: false,
  resolved: false
});

function call(name, input, eventIndex) {
  return {
    id: `${name}-${eventIndex}`,
    name,
    input,
    eventIndex,
    resultEventIndex: eventIndex + 1,
    success: true
  };
}

describe('agent dev semantic assertions', () => {
  it('requires delivery, full skill load, and exact find_work args in order', () => {
    const parsed = {
      toolCalls: [
        call('Shell', { command: `${command} wait --timeout 0` }, 0),
        call('Read', { file_path: '/tmp/.agents/skills/uclusion/SKILL.md' }, 2),
        call('mcp__Uclusion__find_work', {}, 4)
      ],
      skillEndSentinel: '<!-- /uclusion-skill:v1 -->',
      sentinelEventIndexes: [3]
    };
    assert.doesNotThrow(() => assertScenario({
      client: 'codex',
      scenario: 'idle-find-work',
      parsed,
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: { ...stableState }
    }));
  });

  it('requires the real Poke line before skill load and exact get_job triage', () => {
    const parsed = {
      expectedPoke: 'Start J-probe-1',
      pokeEventIndexes: [2],
      toolCalls: [
        call('Shell', { command: `${command} wait --timeout 0` }, 0),
        call('Read', { path: '/tmp/.cursor/skills/uclusion/SKILL.md' }, 3),
        call('mcp__Uclusion__get_job', { short_code_id: 'J-probe-1' }, 5)
      ],
      skillEndSentinel: '<!-- /uclusion-skill:v1 -->',
      sentinelEventIndexes: [4]
    };
    assert.doesNotThrow(() => assertScenario({
      client: 'cursor',
      scenario: 'first-poke',
      parsed,
      expectedCommand: command,
      targetShortCode: 'J-probe-1',
      stateBefore: stableState,
      stateAfter: { ...stableState }
    }));
    const wrong = structuredClone(parsed);
    wrong.toolCalls[2].input.short_code_id = 'J-invented-2';
    assert.throws(() => assertScenario({
      client: 'cursor',
      scenario: 'first-poke',
      parsed: wrong,
      expectedCommand: command,
      targetShortCode: 'J-probe-1',
      stateBefore: stableState,
      stateAfter: { ...stableState }
    }), /exact correlated short code/);
  });

  it('requires Claude to check before arming exactly one persistent monitor', () => {
    const parsed = {
      toolCalls: [
        call('TaskList', {}, 0),
        call('Monitor', {
          command: `${command} listen`,
          persistent: true
        }, 1)
      ]
    };
    assert.doesNotThrow(() => assertScenario({
      client: 'claude',
      scenario: 'session-start',
      parsed,
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: { ...stableState }
    }));
    parsed.toolCalls[1].input.persistent = false;
    assert.throws(() => assertScenario({
      client: 'claude',
      scenario: 'session-start',
      parsed,
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: { ...stableState }
    }), /persistent/);
  });

  it('fails on a durable fixture stage mutation even when tool calls pass', () => {
    assert.throws(() => assertScenario({
      client: 'codex',
      scenario: 'session-start',
      parsed: {
        toolCalls: [call('Shell', { command: `${command} wait --timeout 0` }, 0)]
      },
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: { ...stableState, stage_id: 'reviewable' }
    }), /durable dev fixture/);
  });

  it('rejects extra delivery consumers and mutating MCP calls', () => {
    const base = {
      toolCalls: [
        call('Shell', { command: `${command} wait --timeout 0` }, 0),
        call('Shell', { command: `${command} listen` }, 1)
      ]
    };
    assert.throws(() => assertScenario({
      client: 'codex',
      scenario: 'session-start',
      parsed: base,
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: stableState
    }), /extra wait\/listen/);

    assert.throws(() => assertScenario({
      client: 'codex',
      scenario: 'session-start',
      parsed: {
        toolCalls: [
          call('Shell', { command: `${command} wait --timeout 0` }, 0),
          call('mcp__Uclusion__add_info', { short_code_id: 'J-probe-1', info: 'oops' }, 1)
        ]
      },
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: stableState
    }), /mutating Uclusion tools/);

    assert.throws(() => assertScenario({
      client: 'codex',
      scenario: 'session-start',
      parsed: {
        toolCalls: [
          call('Shell', { command: `${command} wait --timeout 0` }, 0),
          call('mcp__Uclusion__change_job_stage', {
            short_code_id: 'J-probe-1', stage: 'Reviewable'
          }, 1)
        ]
      },
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: stableState
    }), /mutating Uclusion tools/);
  });

  it('rejects extra read-only Uclusion calls outside each exact scenario contract', () => {
    assert.throws(() => assertScenario({
      client: 'codex',
      scenario: 'idle-find-work',
      parsed: {
        toolCalls: [
          call('Shell', { command: `${command} wait --timeout 0` }, 0),
          call('Read', { file_path: '/tmp/.agents/skills/uclusion/SKILL.md' }, 1),
          call('mcp__Uclusion__find_work', {}, 3),
          call('mcp__Uclusion__get_job', { short_code_id: 'J-probe-1' }, 4)
        ],
        skillEndSentinel: '<!-- /uclusion-skill:v1 -->',
        sentinelEventIndexes: [2]
      },
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: stableState
    }), /exactly these Uclusion tools/);
  });

  it('rejects failed and started-only operations', () => {
    for (const success of [false, null]) {
      const delivery = call('Shell', { command: `${command} wait --timeout 0` }, 0);
      delivery.success = success;
      assert.throws(() => assertScenario({
        client: 'codex',
        scenario: 'session-start',
        parsed: { toolCalls: [delivery] },
        expectedCommand: command,
        stateBefore: stableState,
        stateAfter: stableState
      }), /failed or started-only/);
    }
  });

  it('accepts Claude native Skill success as platform-confirmed skill loading', () => {
    const parsed = {
      toolCalls: [
        call('TaskList', {}, 0),
        call('Monitor', { command: `${command} listen`, persistent: true }, 1),
        call('Skill', { skill: 'uclusion' }, 3),
        call('mcp__Uclusion__find_work', {}, 5)
      ],
      sentinelEventIndexes: [],
      skillEndSentinel: '<!-- /uclusion-skill:v1 -->'
    };
    assert.doesNotThrow(() => assertScenario({
      client: 'claude',
      scenario: 'idle-find-work',
      parsed,
      expectedCommand: command,
      stateBefore: stableState,
      stateAfter: stableState
    }));
  });
});
