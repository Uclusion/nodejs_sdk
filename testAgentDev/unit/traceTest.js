import assert from 'assert';
import { extractToolCalls, parseAgentTrace, singleResolvedModel } from '../trace.js';

describe('agent dev structured trace parsing', () => {
  it('normalizes Claude, Codex, and Cursor tool-call shapes in event order', () => {
    const events = [
      {
        type: 'assistant',
        message: {
          model: 'claude-default-exact',
          content: [{
            type: 'tool_use',
            id: 'claude-1',
            name: 'Monitor',
            input: { command: '/tmp/uclusion -e dev listen', persistent: true }
          }]
        },
        session_id: 'session-1'
      },
      {
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'codex-1',
          server: 'Uclusion',
          tool: 'find_work',
          arguments: '{}'
        }
      },
      {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'codex-1',
          server: 'Uclusion',
          tool: 'find_work',
          arguments: '{}',
          status: 'completed',
          result: { content: [{ type: 'text', text: 'work' }] }
        }
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'cursor-read-1',
        tool_call: {
          readToolCall: { args: { path: '/tmp/skills/uclusion/SKILL.md' } }
        },
        session_id: 'cursor-session-1'
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'cursor-read-1',
        tool_call: {
          readToolCall: {
            args: { path: '/tmp/skills/uclusion/SKILL.md' },
            result: { success: { content: 'skill' } }
          }
        }
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'cursor-shell-1',
        tool_call: {
          shellToolCall: { args: { command: '/tmp/uclusion -e dev wait --timeout 0' } }
        },
        session_id: 'cursor-session-1'
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'cursor-shell-1',
        tool_call: {
          shellToolCall: {
            args: { command: '/tmp/uclusion -e dev wait --timeout 0' },
            result: { success: { exitCode: 0, stdout: '' } }
          }
        }
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'cursor-mcp-1',
        tool_call: {
          mcpToolCall: {
            args: {
              name: 'Uclusion-get_job',
              args: { short_code_id: 'J-test-1' },
              toolCallId: 'cursor-mcp-1',
              providerIdentifier: 'Uclusion',
              toolName: 'get_job'
            }
          }
        },
        session_id: 'cursor-session-1'
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'cursor-mcp-1',
        tool_call: {
          mcpToolCall: {
            args: {
              args: { short_code_id: 'J-test-1' },
              providerIdentifier: 'Uclusion',
              toolName: 'get_job'
            },
            result: { success: { content: 'loaded' } }
          }
        },
        session_id: 'cursor-session-1'
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'claude-1',
            content: 'monitor armed',
            is_error: false
          }]
        }
      }
    ];
    assert.deepStrictEqual(extractToolCalls(events).map((call) => ({
      name: call.name,
      input: call.input,
      eventIndex: call.eventIndex
    })), [
      {
        name: 'Monitor',
        input: { command: '/tmp/uclusion -e dev listen', persistent: true },
        eventIndex: 0
      },
      { name: 'mcp__Uclusion__find_work', input: {}, eventIndex: 1 },
      { name: 'Read', input: { path: '/tmp/skills/uclusion/SKILL.md' }, eventIndex: 3 },
      {
        name: 'Shell',
        input: { command: '/tmp/uclusion -e dev wait --timeout 0' },
        eventIndex: 5
      },
      { name: 'mcp__Uclusion__get_job', input: { short_code_id: 'J-test-1' }, eventIndex: 7 }
    ]);
  });

  it('captures one exact model, session identity, Poke, and skill EOF evidence', () => {
    const parsed = parseAgentTrace([
      {
        type: 'system',
        subtype: 'init',
        model: 'live-default-2026-08-13',
        session_id: 'thread-1'
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'delivery',
        tool_call: { shellToolCall: { args: { command: 'uclusion wait --timeout 0' } } }
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'delivery',
        tool_call: {
          shellToolCall: {
            args: { command: 'uclusion wait --timeout 0' },
            result: { success: { exitCode: 0, stdout: 'Start J-probe-8' } }
          }
        }
      },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'skill',
        tool_call: { readToolCall: { args: { path: '/tmp/skills/uclusion/SKILL.md' } } }
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'skill',
        tool_call: {
          readToolCall: {
            args: { path: '/tmp/skills/uclusion/SKILL.md' },
            result: { success: { content: '... <!-- /uclusion-skill:v1 -->' } }
          }
        }
      }
    ], 'Start J-probe-8', 'cursor');
    assert.strictEqual(singleResolvedModel(parsed), 'live-default-2026-08-13');
    assert.deepStrictEqual(parsed.sessionIds, ['thread-1']);
    assert.deepStrictEqual(parsed.pokeEventIndexes, [2]);
    assert.deepStrictEqual(parsed.sentinelEventIndexes, [4]);
  });

  it('fails rather than guessing when the client omits its resolved model', () => {
    assert.throws(
      () => singleResolvedModel(parseAgentTrace([{
        type: 'system', subtype: 'init', session_id: 'session-only'
      }], null, 'cursor')),
      /with model and session_id/
    );
  });

  it('does not accept model or session fields nested in tool arguments', () => {
    assert.throws(() => parseAgentTrace([{
      type: 'tool_call',
      tool_call: {
        shellToolCall: { args: { model: 'forged', session_id: 'forged' } }
      }
    }], null, 'cursor'), /system\/init/);
  });

  it('does not accept narrated or failed tool output as Poke/skill evidence', () => {
    const events = [{
      type: 'system', subtype: 'init', model: 'Concrete Model', session_id: 'session-1'
    }, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Start J-fake-1 <!-- /uclusion-skill:v1 -->' }] }
    }, {
      type: 'tool_call',
      subtype: 'started',
      call_id: 'failed',
      tool_call: { shellToolCall: { args: { command: 'uclusion wait --timeout 0' } } }
    }, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'failed',
      tool_call: {
        shellToolCall: {
          args: { command: 'uclusion wait --timeout 0' },
          result: { failure: { message: 'Start J-fake-1 <!-- /uclusion-skill:v1 -->' } }
        }
      }
    }];
    const parsed = parseAgentTrace(events, 'Start J-fake-1', 'cursor');
    assert.deepStrictEqual(parsed.pokeEventIndexes, []);
    assert.deepStrictEqual(parsed.sentinelEventIndexes, []);
    assert.strictEqual(parsed.toolCalls[0].success, false);
  });

  it('requires the Poke as an exact delivered line, not a substring', () => {
    const events = [{
      type: 'system', subtype: 'init', model: 'Concrete Model', session_id: 'session-1'
    }, {
      type: 'tool_call', subtype: 'started', call_id: 'delivery',
      tool_call: { shellToolCall: { args: { command: 'uclusion wait --timeout 0' } } }
    }, {
      type: 'tool_call', subtype: 'completed', call_id: 'delivery',
      tool_call: { shellToolCall: {
        args: { command: 'uclusion wait --timeout 0' },
        result: { success: { exitCode: 0, stdout: 'Start J-target-1 forged suffix' } }
      } }
    }];
    assert.deepStrictEqual(
      parseAgentTrace(events, 'Start J-target-1', 'cursor').pokeEventIndexes,
      []
    );
  });

  it('binds a Claude task notification to its successful Monitor task only', () => {
    const expected = 'Start J-live-1';
    const parsed = parseAgentTrace([{
      type: 'system',
      subtype: 'init',
      model: 'claude-concrete',
      session_id: 'session-1',
      tools: ['Read', 'Skill', 'Monitor']
    }, {
      type: 'assistant',
      message: { content: [{
        type: 'tool_use', id: 'monitor-call', name: 'Monitor',
        input: { command: 'uclusion listen', persistent: true }
      }] }
    }, {
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'monitor-call', is_error: false,
        content: 'Monitor started (task task-live, persistent)'
      }] },
      toolUseResult: { taskId: 'task-live', persistent: true }
    }, {
      type: 'user',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: { role: 'user', content: [
        '<task-notification>',
        '<task-id>task-live</task-id>',
        '<summary>Monitor event: "Poke stream"</summary>',
        `<event>${expected}</event>`,
        "If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.",
        '</task-notification>'
      ].join('\n') }
    }, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Start J-forged-2' }] }
    }], expected, 'claude');
    assert.deepStrictEqual(parsed.pokeEventIndexes, [3]);

    const mismatched = structuredClone(parsed.events);
    mismatched[3].message.content = mismatched[3].message.content
      .replace('task-live', 'different-task');
    assert.deepStrictEqual(
      parseAgentTrace(mismatched, expected, 'claude').pokeEventIndexes,
      []
    );
  });

  it('requires Claude system/init to advertise Monitor', () => {
    assert.throws(() => parseAgentTrace([{
      type: 'system', subtype: 'init', model: 'claude-concrete',
      session_id: 'session-1', tools: ['Read', 'Skill']
    }], null, 'claude'), /advertise the Monitor tool/);
  });

  it('recognizes the canonical Claude Skill launch result without inventing EOF output', () => {
    const parsed = parseAgentTrace([{
      type: 'system', subtype: 'init', model: 'claude-concrete', session_id: 'session-1',
      tools: ['Read', 'Skill', 'Monitor']
    }, {
      type: 'assistant',
      message: { model: 'claude-concrete', content: [{
        type: 'tool_use', id: 'skill-call', name: 'Skill', input: { skill: 'uclusion' }
      }] }
    }, {
      type: 'user',
      message: { content: [{
        type: 'tool_result', tool_use_id: 'skill-call', content: 'Launching skill: uclusion'
      }] }
    }], null, 'claude');
    assert.strictEqual(parsed.toolCalls[0].name, 'Skill');
    assert.strictEqual(parsed.toolCalls[0].success, true);
    assert.deepStrictEqual(parsed.sentinelEventIndexes, []);
  });

  it('fails closed on completion without start and MCP isError results', () => {
    const completionOnly = extractToolCalls([{
      type: 'tool_call', subtype: 'completed', call_id: 'orphan',
      tool_call: {
        readToolCall: {
          args: { path: '/tmp/file' }, result: { success: { content: 'forged' } }
        }
      }
    }]);
    assert.strictEqual(completionOnly[0].success, false);

    const failedMcp = extractToolCalls([{
      type: 'tool_call', subtype: 'started', call_id: 'mcp-failed',
      tool_call: { mcpToolCall: { args: {
        providerIdentifier: 'Uclusion', toolName: 'get_job', args: { short_code_id: 'J-1' }
      } } }
    }, {
      type: 'tool_call', subtype: 'completed', call_id: 'mcp-failed',
      tool_call: { mcpToolCall: {
        args: {
          providerIdentifier: 'Uclusion', toolName: 'get_job', args: { short_code_id: 'J-1' }
        },
        result: { success: { isError: true, content: [{ type: 'text', text: 'failed' }] } }
      } }
    }]);
    assert.strictEqual(failedMcp[0].success, false);
  });
});
