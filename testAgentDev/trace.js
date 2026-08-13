import assert from 'assert';

const SKILL_END_SENTINEL = '<!-- /uclusion-skill:v1 -->';

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function parseArguments(value) {
  if (typeof value !== 'string') {
    return asObject(value);
  }
  try {
    return asObject(JSON.parse(value));
  } catch (_error) {
    return { raw: value };
  }
}

function upsertToolCall(state, call, eventIndex, update = {}, requireStart = true) {
  const normalized = {
    id: call.id || null,
    name: call.name || '',
    kind: call.kind || call.name || '',
    input: parseArguments(call.input),
    modelCallId: call.modelCallId || null,
    eventIndex,
    success: null,
    resultEventIndex: null,
    evidence: []
  };
  if (!normalized.id && !update.completed) {
    normalized.success = false;
    normalized.malformed = 'missing_call_id';
  }
  const fingerprint = normalized.id || JSON.stringify([
    eventIndex,
    normalized.name,
    normalized.input
  ]);
  let existing = state.byId.get(fingerprint);
  if (update.completed && !existing && requireStart) {
    normalized.success = false;
    normalized.resultEventIndex = eventIndex;
    normalized.malformed = 'completion_without_start';
    state.byId.set(fingerprint, normalized);
    state.calls.push(normalized);
    return normalized;
  }
  if (!existing) {
    existing = normalized;
    state.byId.set(fingerprint, existing);
    state.calls.push(existing);
  } else if (!update.completed) {
    existing.success = false;
    existing.malformed = 'duplicate_start';
    return existing;
  }
  if (update.completed) {
    if (
      existing.resultEventIndex !== null ||
      existing.name !== normalized.name ||
      existing.kind !== normalized.kind ||
      existing.modelCallId !== normalized.modelCallId ||
      JSON.stringify(existing.input) !== JSON.stringify(normalized.input)
    ) {
      existing.success = false;
      existing.malformed = existing.resultEventIndex !== null
        ? 'duplicate_completion'
        : 'completion_call_mismatch';
      return existing;
    }
    existing.success = Boolean(update.success);
    existing.resultEventIndex = eventIndex;
    existing.completeSkillRead = Boolean(update.completeSkillRead);
    existing.evidence.push(...(update.evidence || []).map((text) => ({
      eventIndex,
      text
    })));
  }
  return existing;
}

function cursorToolName(variant) {
  const names = {
    readToolCall: 'Read',
    readFileToolCall: 'Read',
    shellToolCall: 'Shell',
    writeToolCall: 'Write',
    writeFileToolCall: 'Write',
    editToolCall: 'Edit',
    editFileToolCall: 'Edit',
    listToolCall: 'List',
    lsToolCall: 'List',
    grepToolCall: 'Grep',
    searchToolCall: 'Search'
  };
  if (names[variant]) {
    return names[variant];
  }
  const withoutSuffix = String(variant).replace(/ToolCall$/, '');
  return withoutSuffix
    ? `${withoutSuffix[0].toUpperCase()}${withoutSuffix.slice(1)}`
    : '';
}

function cursorCall(node) {
  if (node.type !== 'tool_call') {
    return null;
  }
  const wrapper = asObject(node.tool_call);
  // Cursor includes lifecycle metadata alongside the one typed tool payload.
  // Only the *ToolCall member identifies the operation.
  const variants = Object.entries(wrapper).filter(([key, value]) =>
    key.endsWith('ToolCall') && value && typeof value === 'object' && !Array.isArray(value));
  if (variants.length !== 1) {
    return null;
  }
  const [variant, rawPayload] = variants[0];
  const payload = asObject(rawPayload);
  const args = parseArguments(payload.args ?? payload.arguments ?? payload.input);
  if (variant === 'mcpToolCall') {
    const provider = args.providerIdentifier || args.provider_identifier ||
      args.server || args.serverName || args.server_name;
    const tool = args.toolName || args.tool_name || args.tool;
    if (!provider || !tool) {
      return null;
    }
    return {
      id: node.call_id || node.id || args.toolCallId,
      modelCallId: nonempty(node.model_call_id),
      name: `mcp__${provider}__${tool}`,
      input: args.args ?? args.arguments ?? args.input ?? {},
      payload,
      variant,
      kind: `cursor:${variant}`
    };
  }
  return {
    id: node.call_id || node.id || args.toolCallId,
    modelCallId: nonempty(node.model_call_id),
    name: cursorToolName(variant),
    input: args,
    payload,
    variant,
    kind: `cursor:${variant}`
  };
}

function mcpResultTexts(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      return [block.text];
    }
    if (block?.text && typeof block.text.text === 'string') {
      return [block.text.text];
    }
    return [];
  });
}

function cursorOutcome(node, call) {
  if (node.subtype !== 'completed') {
    return null;
  }
  const result = asObject(call.payload.result);
  if (
    !Object.hasOwn(result, 'success') ||
    Object.hasOwn(result, 'failure') ||
    Object.hasOwn(result, 'error')
  ) {
    return { success: false, evidence: [] };
  }
  const success = asObject(result.success);
  if (call.variant === 'shellToolCall') {
    return {
      success: success.exitCode === 0,
      evidence: success.exitCode === 0 && typeof success.stdout === 'string'
        ? [success.stdout]
        : []
    };
  }
  if (call.variant === 'mcpToolCall') {
    const succeeded = success.isError !== true && success.is_error !== true;
    return { success: succeeded, evidence: succeeded ? mcpResultTexts(success.content) : [] };
  }
  const content = success.content;
  const readRange = asObject(success.readRange);
  const completeSkillRead = call.variant === 'readToolCall' &&
    /(?:^|\/)skills\/uclusion\/SKILL\.md$/.test(String(call.input.path || '')) &&
    success.exceededLimit === false && readRange.startLine === 1 &&
    Number.isInteger(success.totalLines) && readRange.endLine === success.totalLines;
  return {
    success: true,
    evidence: typeof content === 'string' ? [content] : mcpResultTexts(content),
    completeSkillRead
  };
}

function codexCall(item) {
  if (['mcp_tool_call', 'mcp_call'].includes(item.type)) {
    const server = item.server || item.server_name || item.mcp_server || 'Uclusion';
    const tool = item.tool || item.tool_name || item.name;
    if (!tool) {
      return null;
    }
    return {
      id: item.id || item.call_id,
      name: `mcp__${server}__${tool}`,
      input: item.arguments ?? item.args ?? item.input,
      output: item.result,
      kind: `codex:${item.type}`
    };
  }
  if (['command_execution', 'command'].includes(item.type) && item.command) {
    return {
      id: item.id || item.call_id,
      name: 'Shell',
      input: {
        command: Array.isArray(item.command) ? item.command.join(' ') : item.command
      },
      output: item.aggregated_output ?? item.stdout,
      kind: `codex:${item.type}`
    };
  }
  if (item.type === 'function_call' && typeof item.name === 'string') {
    return {
      id: item.call_id || item.id,
      name: item.name,
      input: item.arguments ?? item.input,
      output: item.output ?? item.result,
      kind: `codex:${item.type}`
    };
  }
  return null;
}

function codexSuccess(item) {
  if (item.status !== 'completed') {
    return false;
  }
  if (item.error || item.failure) {
    return false;
  }
  if (['command_execution', 'command'].includes(item.type)) {
    return item.exit_code === 0;
  }
  if (['mcp_tool_call', 'mcp_call'].includes(item.type)) {
    return item.result !== undefined && item.result !== null &&
      item.result?.isError !== true && item.result?.is_error !== true;
  }
  return item.output !== undefined || item.result !== undefined;
}

function claudeResultTexts(content) {
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
}

function parseTaskNotification(content) {
  if (typeof content !== 'string') {
    return null;
  }
  const match = content.match(
    /^<task-notification>\n<task-id>([^<\n]+)<\/task-id>\n<summary>Monitor event: "[^"]+"<\/summary>\n<event>([\s\S]*?)<\/event>\nIf this event is something the user would act on now, send a PushNotification\. Routine or benign output doesn't need one\.\n<\/task-notification>$/
  );
  return match ? { taskId: match[1], text: match[2] } : null;
}

function processClaudeEvent(event, eventIndex, state) {
  const content = event?.message?.content;
  if (event?.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        upsertToolCall(state, {
          id: block.id,
          name: block.name,
          input: block.input
        }, eventIndex);
      }
    }
    return;
  }
  if (event?.type === 'system' && event?.subtype === 'task_started') {
    const monitor = event.tool_use_id ? state.byId.get(event.tool_use_id) : null;
    if (monitor?.name === 'Monitor' && event.task_id) {
      monitor.taskId = event.task_id;
    }
    return;
  }
  if (
    event?.type === 'system' &&
    ['task_updated', 'task_notification'].includes(event?.subtype) &&
    (event?.patch?.status === 'failed' || event?.status === 'failed')
  ) {
    const monitor = state.calls.find((call) =>
      call.name === 'Monitor' && call.taskId === event.task_id);
    if (monitor) {
      monitor.success = false;
      monitor.resultEventIndex = eventIndex;
    }
    return;
  }
  if (event?.type === 'user' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'tool_result') {
        continue;
      }
      const id = block.tool_use_id || block.toolUseId;
      const existing = id ? state.byId.get(id) : null;
      if (!existing) {
        upsertToolCall(state, { id, name: '', input: {} }, eventIndex, {
          completed: true,
          success: false
        });
        continue;
      }
      upsertToolCall(state, existing, eventIndex, {
        completed: true,
        success: block.is_error !== true && !block.error,
        evidence: claudeResultTexts(block.content)
      });
      const taskId = event.toolUseResult?.taskId || event.tool_use_result?.task_id;
      if (taskId && existing.name === 'Monitor' && existing.success === true) {
        existing.taskId = taskId;
      }
    }
    return;
  }
  if (
    event?.type === 'user' &&
    event?.origin?.kind === 'task-notification' &&
    event?.promptSource === 'system'
  ) {
    const notification = parseTaskNotification(content);
    const monitor = notification && state.calls.find((call) =>
      call.name === 'Monitor' && call.success === true && call.taskId === notification.taskId);
    if (monitor) {
      monitor.evidence.push({ eventIndex, text: notification.text });
    }
  }
}

function unique(values) {
  return [...new Set(values)];
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function extractClientMetadata(events, client) {
  if (client === 'codex') {
    const starts = events.filter((event) => event?.type === 'thread.started');
    if (starts.length !== 1 || !nonempty(starts[0].thread_id)) {
      throw new Error(
        `Codex JSONL must expose exactly one thread.started thread_id; found ${starts.length}`
      );
    }
    return { models: [], sessionIds: [starts[0].thread_id.trim()] };
  }
  if (client === 'cursor') {
    const starts = events.filter(
      (event) => event?.type === 'system' && event?.subtype === 'init'
    );
    if (starts.length !== 1 || !nonempty(starts[0].session_id) || !nonempty(starts[0].model)) {
      throw new Error(
        `Cursor stream must expose one system/init event with model and session_id; ` +
          `found ${starts.length}`
      );
    }
    const modelCallIds = unique(events.map((event) => nonempty(event?.model_call_id))
      .filter(Boolean));
    return {
      models: [starts[0].model.trim()],
      sessionIds: [starts[0].session_id.trim()],
      modelCallIds
    };
  }
  if (client === 'claude') {
    const starts = events.filter(
      (event) => event?.type === 'system' && event?.subtype === 'init'
    );
    const sessionIds = unique(starts.map((event) => nonempty(event.session_id)).filter(Boolean));
    if (starts.length < 1 || sessionIds.length !== 1) {
      throw new Error(
        `Claude stream must expose one unique system/init session_id; found ` +
          `${starts.length} events and ${JSON.stringify(sessionIds)}`
      );
    }
    if (starts.some((event) => !Array.isArray(event.tools) || !event.tools.includes('Monitor'))) {
      throw new Error(
        'Claude system/init must advertise the Monitor tool for persistent Poke delivery'
      );
    }
    const initModel = nonempty(starts[0].model);
    const canonical = (model) => model?.replace(/\[[^\]]+\]$/, '');
    const canonicalModels = unique([
      initModel,
      ...events
        .filter((event) => event?.type === 'assistant')
        .map((event) => nonempty(event?.message?.model))
    ].filter(Boolean).map(canonical));
    if (!initModel || canonicalModels.length !== 1) {
      throw new Error(
        `Claude stream must expose exactly one assistant/system model; found ` +
          JSON.stringify(canonicalModels)
      );
    }
    return { models: [initModel], sessionIds };
  }
  throw new Error(`Unknown trace client ${client}`);
}

function extractTraceStructure(events, client = null) {
  const state = { calls: [], byId: new Map() };
  events.forEach((event, eventIndex) => {
    if (client === 'claude') {
      processClaudeEvent(event, eventIndex, state);
      return;
    }
      const cursor = cursorCall(event);
    if (cursor) {
      const outcome = cursorOutcome(event, cursor);
      upsertToolCall(state, cursor, eventIndex, outcome === null ? {} : {
        completed: true,
        success: outcome.success,
        evidence: outcome.evidence,
        completeSkillRead: outcome.completeSkillRead
      });
      return;
    }
    if (['item.started', 'item.completed'].includes(event?.type)) {
      const item = asObject(event.item);
      const call = codexCall(item);
      if (call) {
        upsertToolCall(state, call, eventIndex, event.type === 'item.completed' ? {
          completed: true,
          success: codexSuccess(item),
          evidence: codexSuccess(item)
            ? (typeof call.output === 'string'
                ? [call.output]
                : mcpResultTexts(call.output?.content))
            : []
        } : {}, false);
      }
      return;
    }
    if (client === null) {
      processClaudeEvent(event, eventIndex, state);
    }
  });
  return state.calls.sort((left, right) => left.eventIndex - right.eventIndex);
}

function publicToolCall(call) {
  return {
    id: call.id,
    modelCallId: call.modelCallId,
    name: call.name,
    input: call.input,
    eventIndex: call.eventIndex,
    resultEventIndex: call.resultEventIndex,
    success: call.success,
    completeSkillRead: Boolean(call.completeSkillRead)
  };
}

function extractReportedUsage(events, client) {
  if (client === 'claude') {
    const results = events.filter((event) =>
      event?.type === 'result' && event?.subtype === 'success' && event?.is_error === false);
    const result = results.at(-1);
    return result ? {
      total_cost_usd: result.total_cost_usd,
      usage: result.usage,
      model_usage: result.modelUsage
    } : null;
  }
  if (client === 'codex') {
    const result = events.filter((event) => event?.type === 'turn.completed').at(-1);
    return result?.usage ? { usage: result.usage } : null;
  }
  if (client === 'cursor') {
    const result = events.filter((event) =>
      event?.type === 'result' && event?.subtype === 'success' && event?.is_error === false).at(-1);
    return result?.usage ? { usage: result.usage } : null;
  }
  return null;
}

export function extractToolCalls(events) {
  return extractTraceStructure(events).map(publicToolCall);
}

export function parseAgentTrace(events, expectedPoke = null, client) {
  const metadata = extractClientMetadata(events, client);
  const structuredCalls = extractTraceStructure(events, client);
  const sentinelEventIndexes = [];
  const completeSkillReadEventIndexes = [];
  const pokeEventIndexes = [];
  for (const call of structuredCalls) {
    if (call.success !== true) {
      continue;
    }
    if (
      expectedPoke && call.name === 'Skill' &&
      String(call.input?.skill || call.input?.name || '').replace(/^\$/, '') === 'uclusion' &&
      (!call.input?.args || String(call.input.args).trim() === expectedPoke)
    ) {
      // Claude's Monitor-triggered turn invokes the native skill, but some
      // live stream versions omit the claimed line from both the Skill args
      // and notification envelope. The initial prompt is deliberately
      // unrelated; the fixture has already observed both the dev send receipt
      // and proxy persistence, and the later exact get_job binds the target.
      pokeEventIndexes.push(call.eventIndex);
    }
    if (call.completeSkillRead) {
      completeSkillReadEventIndexes.push(call.resultEventIndex);
    }
    for (const evidence of call.evidence) {
      if (evidence.text.includes(SKILL_END_SENTINEL)) {
        sentinelEventIndexes.push(evidence.eventIndex);
      }
      if (expectedPoke && evidence.text.split(/\r?\n/).some(
        (line) => line.trim() === expectedPoke
      )) {
        pokeEventIndexes.push(evidence.eventIndex);
      }
    }
  }
  return {
    events,
    toolCalls: structuredCalls.map(publicToolCall),
    models: metadata.models,
    sessionIds: metadata.sessionIds,
    modelCallIds: metadata.modelCallIds || [],
    reportedUsage: extractReportedUsage(events, client),
    skillEndSentinel: SKILL_END_SENTINEL,
    sentinelEventIndexes,
    completeSkillReadEventIndexes,
    expectedPoke,
    pokeEventIndexes
  };
}

export function singleResolvedModel(parsed) {
  if (parsed.models.length !== 1) {
    throw new Error(
      `Trace must expose exactly one resolved model; found ${JSON.stringify(parsed.models)}`
    );
  }
  return parsed.models[0];
}
