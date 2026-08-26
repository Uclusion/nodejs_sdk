import assert from 'assert';

function normalizedName(call) {
  return String(call.name || '').toLowerCase();
}

function commandOf(call) {
  const command = call.input?.command ?? call.input?.cmd;
  return Array.isArray(command) ? command.join(' ') : String(command || '').trim();
}

function isMcpTool(call, tool) {
  const name = normalizedName(call);
  return name === `mcp__uclusion__${tool}` ||
    name === `uclusion.${tool}`;
}

function mcpCalls(parsed, tool) {
  return parsed.toolCalls.filter((call) => isMcpTool(call, tool));
}

function containsExactShellCommand(command, expected) {
  let offset = 0;
  while (offset <= command.length) {
    const index = command.indexOf(expected, offset);
    if (index === -1) {
      return false;
    }
    const before = command.slice(0, index).trimEnd();
    const after = command.slice(index + expected.length);
    const beforeOk = !before || /(?:[;&|('\"]|\bthen|\belse|\bdo)$/.test(before);
    const afterOk = !after.trim() || /^\s*(?:[;&|)\n]|['\"]\s*$)/.test(after);
    if (beforeOk && afterOk) {
      return true;
    }
    offset = index + 1;
  }
  return false;
}

function deliveryCalls(parsed, client, expectedCommand) {
  if (client === 'claude') {
    return parsed.toolCalls.filter((call) =>
      normalizedName(call) === 'monitor' && commandOf(call) === `${expectedCommand} listen`);
  }
  return parsed.toolCalls.filter((call) => {
    const name = normalizedName(call);
    return ['shell', 'bash', 'exec_command', 'command_execution'].includes(name) &&
      containsExactShellCommand(commandOf(call), `${expectedCommand} wait --timeout 0`);
  });
}

function allDeliveryCalls(parsed, expectedCommand) {
  return parsed.toolCalls.filter((call) => {
    const name = normalizedName(call);
    const command = commandOf(call);
    if (name === 'monitor') {
      return command === `${expectedCommand} listen` ||
        /(?:^|\s)uclusion(?:-dev)?(?:\s+-e\s+\S+)?\s+listen(?:\s|$)/.test(command);
    }
    return ['shell', 'bash', 'exec_command', 'command_execution'].includes(name) && (
      command === `${expectedCommand} listen` ||
      containsExactShellCommand(command, `${expectedCommand} wait --timeout 0`) ||
      /(?:^|\s)uclusion(?:-dev)?(?:\s+-e\s+\S+)?\s+(?:wait|listen)(?:\s|$)/.test(command)
    );
  });
}

function skillCall(call) {
  const name = normalizedName(call);
  if (name === 'skill') {
    return String(call.input?.skill || call.input?.name || '').replace(/^\$/, '') === 'uclusion';
  }
  if (['read', 'read_file'].includes(name)) {
    const file = call.input?.file_path || call.input?.path || '';
    return /(?:^|\/)skills\/uclusion\/SKILL\.md$/.test(file);
  }
  if (['shell', 'bash', 'exec_command', 'command_execution'].includes(name)) {
    return /(?:^|\/)skills\/uclusion\/SKILL\.md(?:\s|['"]|$)/.test(commandOf(call));
  }
  return false;
}

function assertDelivery(parsed, client, expectedCommand) {
  const found = deliveryCalls(parsed, client, expectedCommand);
  assert.strictEqual(
    found.length,
    1,
    `${client} must establish delivery exactly once with the shipped command; calls were ` +
      JSON.stringify(parsed.toolCalls)
  );
  assert.strictEqual(
    allDeliveryCalls(parsed, expectedCommand).length,
    1,
    `${client} must not start an extra wait/listen delivery consumer`
  );
  const delivery = found[0];
  if (client === 'claude') {
    assert.strictEqual(delivery.input.persistent, true,
      'Claude Monitor must be persistent');
    // TaskList, pgrep, and ps pipelines are all real listener prechecks;
    // newer Claude builds defer TaskList, making shell process checks common.
    // The uclusion pattern tolerates the grep self-exclusion idiom [u]clusion.
    const prechecks = parsed.toolCalls.filter((call) =>
      normalizedName(call) === 'tasklist' ||
      (/(?:pgrep|\bps\b)/.test(commandOf(call)) &&
        /\[?u\]?clusion/i.test(commandOf(call))));
    assert(prechecks.length > 0, 'Claude must check for an existing listener before arming');
    assert(prechecks[0].eventIndex < delivery.eventIndex,
      'Claude listener precheck must happen before Monitor arming');
  }
  return delivery;
}

const MUTATING_UCLUSION_TOOLS = new Set([
  'ask_question', 'make_suggestion', 'approve_job_or_option', 'vote_on_suggestion',
  'add_info', 'resolve', 'ask_for_review', 'add_options', 'update_option', 'add_view_note',
  'add_job', 'add_task', 'add_bug', 'add_blocker', 'clear_notifications',
  'request_work', 'change_job_stage',
  'start_job_audit', 'set_job_audit_phase', 'end_job_audit'
]);

function uclusionToolName(call) {
  const name = normalizedName(call);
  if (name.startsWith('mcp__uclusion__')) {
    return name.slice('mcp__uclusion__'.length);
  }
  if (name.startsWith('uclusion.')) {
    return name.slice('uclusion.'.length);
  }
  return null;
}

// Status probes answer through their exit codes: a bridge-presence check
// exits nonzero when the bridge is absent, an ls of a possibly-missing
// skills directory exits nonzero when it does not exist. Exempt failed calls
// only when every command part is a pure existence/metadata probe.
const PROBE_EXECUTABLES = new Set([
  'ls', 'stat', 'wc', 'test', '[', '[[', 'exit', 'echo', 'printf',
  'true', 'false', ':'
]);

function isReadOnlyStatusProbe(command) {
  const body = command
    .replace(/^\/bin\/(?:bash|sh|dash|zsh)\s+-l?c\s+/, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s\d?>>?\s*&?\S+/g, ' ');
  const parts = body.split(/;|\n|&&|\|\|/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => {
    let stripped = part;
    for (let pass = 0; pass < 3; pass += 1) {
      stripped = stripped.replace(/^(?:if|then|else|elif|do)\s+/, '').trim();
    }
    if (['fi', 'done', 'if', 'then', 'else', ''].includes(stripped)) {
      return true;
    }
    return PROBE_EXECUTABLES.has(stripped.split(/\s+/)[0]);
  });
}

function assertReadOnlyTools(parsed) {
  const unsuccessful = parsed.toolCalls.filter((call) => call.success !== true &&
    !(['shell', 'bash', 'exec_command', 'command_execution'].includes(normalizedName(call)) &&
      isReadOnlyStatusProbe(commandOf(call))));
  assert.deepStrictEqual(unsuccessful, [],
    `Trace contains failed or started-only tool calls: ${JSON.stringify(unsuccessful)}`);
  const mutating = parsed.toolCalls.filter((call) => {
    return MUTATING_UCLUSION_TOOLS.has(uclusionToolName(call));
  });
  assert.deepStrictEqual(mutating, [],
    `Read-only probe invoked mutating Uclusion tools: ${JSON.stringify(mutating)}`);
}

function assertExactUclusionCalls(parsed, expected) {
  const actual = parsed.toolCalls.map(uclusionToolName).filter(Boolean);
  assert.deepStrictEqual(actual, expected,
    `Scenario must invoke exactly these Uclusion tools: ${JSON.stringify(expected)}; ` +
      `found ${JSON.stringify(actual)}`);
}

function assertSkillBefore(parsed, beforeEventIndex, afterEventIndex = -1, client = null) {
  const invocations = parsed.toolCalls.filter(skillCall);
  assert(invocations.length > 0, 'Trace must structurally show invocation/read of uclusion skill');
  const invocationIndex = Math.min(...invocations.map((call) => call.eventIndex));
  // The Poke marker may be the skill invocation itself when the stream hides
  // the notification prompt, so equality counts as triggered-by.
  assert(invocationIndex >= afterEventIndex,
    'Uclusion skill invocation must be triggered by or after the correlated Poke');
  assert(invocationIndex < beforeEventIndex,
    'Uclusion skill invocation must precede the Uclusion MCP operation');
  const nativeClaudeSkill = client === 'claude' && invocations.some((call) =>
    normalizedName(call) === 'skill' && call.success === true &&
    String(call.input?.skill || call.input?.name || '').replace(/^\$/, '') === 'uclusion' &&
    call.resultEventIndex > afterEventIndex && call.resultEventIndex < beforeEventIndex);
  if (nativeClaudeSkill) {
    return;
  }
  const completeIndexes = [
    ...parsed.sentinelEventIndexes,
    ...(parsed.completeSkillReadEventIndexes || [])
  ];
  assert(completeIndexes.length > 0,
    `Trace must show a complete load of the skill through ${parsed.skillEndSentinel} ` +
      'or a successful full-range Cursor read');
  const sentinelIndex = Math.min(...completeIndexes);
  assert(sentinelIndex > afterEventIndex,
    'The skill body must load after the correlated Poke triggers it');
  assert(sentinelIndex < beforeEventIndex,
    'The complete skill, including its EOF sentinel, must load before the MCP operation');
}

function assertUnchangedState(before, after) {
  assert.deepStrictEqual(after, before,
    'Read/triage scenario changed the durable dev fixture unexpectedly');
}

// Text every client renders to the human: Claude and Cursor stream assistant
// text blocks; Codex completes agent_message items.
function userVisibleTexts(parsed) {
  const texts = [];
  for (const event of parsed.events || []) {
    if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
    }
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message' &&
        typeof event.item.text === 'string') {
      texts.push(event.item.text);
    }
  }
  return texts;
}

function assertWorkPresentedWithNameAndCode(parsed, targetShortCode, targetName) {
  assert(typeof targetName === 'string' && targetName.trim(),
    'Idle find_work grading requires the exact fixture job name');
  const texts = userVisibleTexts(parsed);
  const paired = texts.filter((text) =>
    text.includes(targetShortCode) && text.includes(targetName));
  assert(paired.length > 0,
    'The agent must present the find_work item to the human with both its short code ' +
      `${targetShortCode} and its description in one message; saw ${JSON.stringify(texts)}`);
}

export function assertScenario({
  client,
  scenario,
  parsed,
  expectedCommand,
  targetShortCode,
  targetName,
  stateBefore,
  stateAfter
}) {
  assertReadOnlyTools(parsed);
  const delivery = assertDelivery(parsed, client, expectedCommand);
  if (scenario === 'session-start') {
    assertExactUclusionCalls(parsed, []);
    assertUnchangedState(stateBefore, stateAfter);
    return;
  }

  if (scenario === 'idle-find-work') {
    assertExactUclusionCalls(parsed, ['find_work']);
    const calls = mcpCalls(parsed, 'find_work');
    assert.strictEqual(calls.length, 1, 'Idle greeting must call find_work exactly once');
    assert.deepStrictEqual(calls[0].input, {}, 'find_work must receive an empty argument object');
    assert(delivery.eventIndex < calls[0].eventIndex,
      'Delivery setup must precede find_work');
    assertSkillBefore(parsed, calls[0].eventIndex, -1, client);
    assertWorkPresentedWithNameAndCode(parsed, targetShortCode, targetName);
    assertUnchangedState(stateBefore, stateAfter);
    return;
  }

  if (scenario === 'first-poke') {
    assertExactUclusionCalls(parsed, ['get_job']);
    const calls = mcpCalls(parsed, 'get_job');
    assert.strictEqual(calls.length, 1, 'First Start Poke must call get_job exactly once');
    assert.deepStrictEqual(calls[0].input, { short_code_id: targetShortCode },
      'Poke triage must load the exact correlated short code without invented arguments');
    assert(delivery.eventIndex < calls[0].eventIndex,
      'Delivery setup/drain must precede Poke triage');
    assert(parsed.pokeEventIndexes.length > 0,
      `Trace must contain the real dev Poke line ${parsed.expectedPoke}`);
    const pokeIndex = Math.min(...parsed.pokeEventIndexes);
    assert(delivery.eventIndex <= pokeIndex,
      'Poke must arrive only after delivery setup began');
    assert(pokeIndex < calls[0].eventIndex,
      'The correlated Poke line must be observed before get_job');
    assertSkillBefore(parsed, calls[0].eventIndex, pokeIndex, client);
    assertUnchangedState(stateBefore, stateAfter);
    return;
  }

  assert.fail(`Unknown scenario ${scenario}`);
}
