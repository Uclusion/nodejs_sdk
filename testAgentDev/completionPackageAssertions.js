import assert from 'assert';
import {
  assertFileLoadedBeforeEvent,
  assertSkillLoadedBeforeSemanticMcp
} from './semanticAssertions.js';
import { mcpResultTexts } from './trace.js';

const READ_ONLY_WORKFLOW_TOOLS = new Set([
  'find_work',
  'get_job',
  'get_notifications'
]);
const WORKFLOW_AUDIT_TOOLS = new Set([
  'start_job_audit',
  'set_job_audit_phase',
  'end_job_audit'
]);
const REFERENCE_START = '<!-- uclusion-skill-reference:v1 -->';
const REFERENCE_END = '<!-- /uclusion-skill-reference:v1 -->';

function isUclusionMcp(call) {
  const name = String(call?.name || '').toLowerCase();
  return name.startsWith('mcp__uclusion__') || name.startsWith('uclusion.');
}

function workflowToolName(call) {
  const name = String(call?.name || '').toLowerCase();
  if (name.startsWith('mcp__uclusion__')) {
    return name.slice('mcp__uclusion__'.length);
  }
  return name.startsWith('uclusion.') ? name.slice('uclusion.'.length) : null;
}

function shellCommand(call) {
  const name = String(call?.name || '').toLowerCase();
  if (!['shell', 'bash', 'exec_command', 'command_execution'].includes(name)) {
    return null;
  }
  const command = call.input?.command ?? call.input?.cmd;
  return Array.isArray(command) ? command.join(' ') : String(command || '');
}

function gitOperationIndex(command, operation) {
  const indexes = [
    new RegExp(`\\bgit\\s+${operation}\\b`),
    new RegExp(`\\bgit\\s+-C\\s+\\S+\\s+${operation}\\b`)
  ].map((pattern) => command.search(pattern)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function gitOperation(command, operation) {
  return gitOperationIndex(command, operation) >= 0;
}

function shellSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let wordStarted = false;
  const finishWord = () => {
    if (wordStarted) {
      words.push(word);
      word = '';
      wordStarted = false;
    }
  };
  const finishSegment = () => {
    finishWord();
    if (words.length) {
      segments.push(words);
      words = [];
    }
  };

  for (const character of command) {
    if (escaped) {
      word += character;
      wordStarted = true;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
    } else if (character === ';' || character === '&' ||
      character === '|' || character === '\n') {
      finishSegment();
    } else if (/\s/.test(character)) {
      finishWord();
    } else {
      word += character;
      wordStarted = true;
    }
  }
  if (quote || escaped) {
    return [];
  }
  finishSegment();
  return segments;
}

function isCompletionPackageExportScript(command, cliWords, depth = 0) {
  if (depth > 4) {
    return false;
  }
  return shellSegments(command).some((words) => {
    const invokesExport = words.length > cliWords.length &&
      cliWords.every((word, index) => words[index] === word) &&
      words[cliWords.length] === 'export';
    if (invokesExport) {
      return true;
    }
    const executable = words[0]?.split('/').at(-1);
    if (!['bash', 'sh', 'zsh'].includes(executable)) {
      return false;
    }
    let commandOptionIndex = -1;
    for (let index = 1; index < words.length; index += 1) {
      if (words[index] === '--' || !words[index].startsWith('-')) {
        break;
      }
      if (/^-[^-]*c/.test(words[index])) {
        commandOptionIndex = index;
        break;
      }
    }
    return commandOptionIndex >= 0 && words[commandOptionIndex + 1] !== undefined &&
      isCompletionPackageExportScript(
        words[commandOptionIndex + 1], cliWords, depth + 1
      );
  });
}

export function isCompletionPackageExportCommand(command, cliCommand) {
  if (typeof command !== 'string' || typeof cliCommand !== 'string' || !cliCommand) {
    return false;
  }
  const cliSegments = shellSegments(cliCommand);
  return cliSegments.length === 1 && cliSegments[0].length > 0 &&
    isCompletionPackageExportScript(command, cliSegments[0]);
}

function exactCalls(calls, name) {
  return calls.filter((call) => workflowToolName(call) === name);
}

function assertExactInput(call, expected, label) {
  assert.deepStrictEqual(call.input, expected,
    `${label} must use the exact durable target and argument shape`);
}

function assertReferenceLoaded(parsed, expectedSkillFiles, relativePath, boundary, label) {
  const expected = expectedSkillFiles?.uclusion?.[relativePath];
  assert(expected, `${label} is missing staged ${relativePath}`);
  assertFileLoadedBeforeEvent(parsed, {
    expectedPath: expected.path,
    expectedContent: expected.content,
    expectedRelativePath: `.agents/skills/uclusion/${relativePath}`,
    expectedStartSentinel: REFERENCE_START,
    expectedEndSentinel: REFERENCE_END,
    beforeEventIndex: boundary,
    label
  });
}

function completedItemFor(parsed, call) {
  return (parsed?.events || []).find((event) =>
    event?.type === 'item.completed' &&
    (event.item?.id === call.id || event.item?.call_id === call.id));
}

function resultTexts(parsed, call) {
  const item = completedItemFor(parsed, call)?.item;
  if (!item) {
    return [];
  }
  if (typeof item.result === 'string') {
    return [item.result];
  }
  return mcpResultTexts(item.result?.content);
}

function createdCommentCode(parsed, call, label) {
  const codes = [...new Set(resultTexts(parsed, call).flatMap((text) =>
    text.match(/\bC-[A-Za-z0-9-]+\b/g) || []))];
  assert.strictEqual(codes.length, 1,
    `${label} must return exactly one durable C- code`);
  return codes[0];
}

function assertActionState(info, label, expected, context) {
  const line = String(info).split('\n').find((candidate) =>
    new RegExp(`\\b${label}(?:\\s+actions?)?\\b`, 'i').test(candidate));
  assert(line, `${context} must name its ${label} actions`);
  if (expected.length === 0) {
    assert(/\b(?:none|empty|no actions?)\b|\[\s*\]/i.test(line),
      `${context} must record no ${label} actions`);
    return;
  }
  const numbers = [...new Set((line.match(/\b[1-4]\b/g) || []).map(Number))].sort();
  if (expected.length === 4 && /\b1\s*(?:-|through|to)\s*4\b/i.test(line)) {
    numbers.splice(0, numbers.length, 1, 2, 3, 4);
  }
  assert.deepStrictEqual(numbers, expected,
    `${context} must record the exact ${label} action numbers`);
}

function assertPackageState(call, {
  source = null,
  selection = null,
  selected = null,
  completed,
  remaining,
  label
}) {
  const info = call.input?.info;
  assert.strictEqual(typeof info, 'string', `${label} must contain durable package state`);
  if (source === 'agent') {
    assert(/\bsource\b[^\n]*(?:agent|chat)/i.test(info),
      `${label} must identify the agent-chat source`);
  }
  if (selection) {
    assert(new RegExp(`canonical\\s+selection[^\\n]*\\b${selection.replace(',', '\\s*,\\s*')}\\b`, 'i')
      .test(info), `${label} must record canonical selection ${selection}`);
  }
  if (selected) {
    assertActionState(info, 'selected', selected, label);
  }
  assertActionState(info, 'completed', completed, label);
  assertActionState(info, 'remaining', remaining, label);
}

function visibleAgentText(parsed) {
  return (parsed?.events || [])
    .filter((event) => event?.type === 'item.completed' &&
      event.item?.type === 'agent_message' && typeof event.item.text === 'string')
    .map((event) => event.item.text)
    .join('\n');
}

function assertNoUnauthorizedShellActions(shellCalls) {
  const commands = shellCalls.map((entry) => entry.command);
  for (const command of commands) {
    if (gitOperation(command, 'push')) {
      assert(!/(?:^|\s)(?:--force(?:-with-lease)?|-f|--mirror)(?:\s|=|$)/.test(command),
        'Completion authorization never permits a force or mirror push');
      assert(!/\bgit(?:\s+-C\s+\S+)?\s+push\b[^;&|\n]*\s\+\S+/.test(command),
        'Completion authorization never permits a force-refspec push');
      assert(!/(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\S+@\S+:)/.test(command),
        'Completion package push must not name a network remote');
    }
    assert(!/(?:^|[;&|]\s*|["']\s*|\s+-lc\s+)(?:npm\s+(?:test|run|exec)\b|pnpm\s+(?:test|run|exec|build)\b|yarn\s+(?:test|run|build)\b|npx\s+(?:mocha|jest)\b|node\s+--test\b|deno\s+test\b|bun\s+(?:test|run|build)\b|pytest\b|python\S*\s+-m\s+pytest\b|mocha\b|cargo\s+(?:test|build)\b|go\s+test\b|mvn\b|gradle\b|\.\/gradlew\b|dotnet\s+(?:test|build)\b|make\b|cmake\s+--build\b|meson\s+compile\b|ninja\b|bazel\s+(?:test|build)\b)/i.test(command),
    'Completion package must not run a test or build command');
    assert(!/(?:^|[;&|]\s*|["']\s*|\s+-lc\s+)(?:npm\s+audit\b|pnpm\s+audit\b|yarn\s+audit\b|pip-audit\b|snyk\b|semgrep\b|bandit\b|trivy\b|gitleaks\b)/i.test(command),
      'Completion package must not perform unapproved security work');
    assert(!/(?:^|[;&|]\s*|["']\s*|\s+-lc\s+)(?:deploy\b|npm\s+run\s+deploy\b|kubectl\s+apply\b)/i.test(command),
      'Completion package must not deploy');
  }
}

function assertCompletionMenu(target) {
  const menu = target.completionMenu;
  assert.strictEqual(typeof menu, 'string',
    'Completion fixture must expose its exact review/chat menu');
  assert.deepStrictEqual([...menu.matchAll(/^(\d+)\. /gm)].map((match) => match[1]),
    ['1', '2', '3', '4'], 'Completion menu must contain exactly actions 1 through 4');
  assert(menu.includes('1. Commit only its reviewed changes'),
    'Completion menu must make commit the first selectable action');
  assert(menu.includes('2. Push only those commits.'),
    'Completion menu must make push the second selectable action');
  assert(menu.includes(`3. Clear only the notifications produced by ${target.jobCode}.`),
    'Completion menu must describe the exact-job notification clear in user language');
  assert(menu.includes(
    `4. Move ${target.jobCode} from Doable to Reviewable and immediately run its completion sweep.`
  ), 'Completion menu must couple the exact Reviewable transition and sweep');
  assert(menu.includes('Reply `all`, `none`, or numbers such as `1,2,4`.'),
    'Completion menu must expose all, none, and numbered-subset responses');
  assert(menu.includes('respond on this review or in the agent'),
    'Completion menu must expose both valid response channels');
  assert(menu.includes('Action 4 is indivisible.'),
    'Completion menu must preserve the indivisible transition and sweep');
  assert(!/required fresh check|get_notifications|^5\. /im.test(menu),
    'Completion menu must not expose internal check language or a fifth action');
}

function assertTargetReload(parsed, workflowCalls, target, label) {
  const reviewLoads = exactCalls(workflowCalls, 'get_job').filter((call) =>
    call.input?.short_code_id === target.reviewCode && call.input?.thread_only === true);
  assert(reviewLoads.length > 0,
    `${label} must reload the exact completion review thread`);
  assert(reviewLoads.some((call) => resultTexts(parsed, call).some((text) =>
    text.includes(target.reviewCode))),
    `${label} review-thread reload must observe the exact review`);
  if (target.reviewReplyCode) {
    assert(reviewLoads.some((call) => resultTexts(parsed, call).some((text) =>
      text.includes(target.reviewReplyCode))),
      `${label} must observe the first valid review-thread reply`);
  }
  const targetLoads = exactCalls(workflowCalls, 'get_job').filter((call) =>
    call.input?.short_code_id === target.jobCode);
  assert(targetLoads.length > 0,
    `${label} must reload the exact job after its valid selection`);
  const assistanceReloads = targetLoads.filter((call) =>
    !Array.isArray(call.input?.sections) || call.input.sections.includes('assistance'));
  assert(assistanceReloads.length > 0,
    `${label} must include assistance in its post-selection exact-job reload`);
  const doableReloads = assistanceReloads.filter((call) =>
    resultTexts(parsed, call).some((text) => text.includes('This job is in stage Doable.')));
  assert(doableReloads.length > 0,
    `${label} must observe the exact job still Doable before package actions`);
  return { targetLoads, doableReloads, reviewLoads };
}

function assertNoPrematureLaneSwitch(workflowCalls, allowedCodes, afterEventIndex = null) {
  const otherJobLoads = workflowCalls.filter((call) =>
    workflowToolName(call) === 'get_job' &&
    !allowedCodes.has(call.input?.short_code_id));
  assert.deepStrictEqual(otherJobLoads, [],
    'Completion-package session must not switch to another job');
  const laneCalls = exactCalls(workflowCalls, 'find_work');
  if (afterEventIndex === null) {
    assert.deepStrictEqual(laneCalls, [],
      'An incomplete completion package must not switch or discover another lane');
    return;
  }
  assert(laneCalls.every((call) => afterEventIndex < call.eventIndex),
    'Any lane discovery must begin only after the phase completion boundary');
}

export function assertCompletionPackageTranscript({
  phase,
  parsed,
  targets,
  expectedSkillPath,
  expectedSkillContent,
  expectedSkillFiles
}) {
  assertSkillLoadedBeforeSemanticMcp(parsed, {
    expectedSkillPath,
    expectedSkillContent
  });
  const targetName = phase.replace('completion-package-', '');
  const target = targets?.[targetName];
  assert(target?.jobCode && target?.taskCode,
    `Unknown or incomplete completion-package phase ${phase}`);
  const expectedSelection = {
    declined: { selection: 'none', source: 'agent', later: null },
    partial: { selection: '1', source: 'review', later: '1,2' },
    full: { selection: 'all', source: 'agent', later: null }
  }[targetName];
  assert.deepStrictEqual({
    selection: target.selection,
    source: target.selectionSource,
    later: target.laterAgentSelection
  }, expectedSelection, `${targetName} completion response fixture has the wrong channel or order`);
  assert.strictEqual(target.reviewReplyCode !== null, targetName === 'partial',
    'Only the partial phase should begin with a valid review-thread reply');
  assertCompletionMenu(target);
  const calls = (parsed?.toolCalls || []).filter(isUclusionMcp);
  assert.deepStrictEqual(calls.filter((call) => call.success !== true), [],
    'Completion-package transcript contains a failed or incomplete Uclusion call');
  const auditCalls = calls.filter((call) =>
    WORKFLOW_AUDIT_TOOLS.has(workflowToolName(call)));
  for (const call of auditCalls) {
    assert.strictEqual(call.input?.job_id, target.jobCode,
      `${workflowToolName(call)} must remain bound to the exact package job`);
  }
  const workflowCalls = calls.filter((call) =>
    !WORKFLOW_AUDIT_TOOLS.has(workflowToolName(call)));
  const mutations = workflowCalls.filter((call) =>
    !READ_ONLY_WORKFLOW_TOOLS.has(workflowToolName(call)));
  const { doableReloads, reviewLoads } = assertTargetReload(
    parsed,
    workflowCalls,
    target,
    `${targetName} completion package`
  );
  const allowedCodes = new Set([
    target.jobCode,
    target.taskCode,
    target.reviewCode,
    target.reviewReplyCode
  ]);
  const shellCalls = (parsed?.toolCalls || [])
    .map((call) => ({ call, command: shellCommand(call) }))
    .filter((entry) => entry.command !== null);
  assertNoUnauthorizedShellActions(shellCalls);
  const agentText = visibleAgentText(parsed);
  assert(!/(?:^|\s)\/clear(?:\s|$)|\bcontext clear\b/i.test(agentText),
    'Completion package must not offer or perform a context clear');
  assert(!agentText.includes('Choose completion actions:'),
    'A valid response must not re-offer the completion menu');

  const commitCalls = shellCalls.filter((entry) => gitOperation(entry.command, 'commit'));
  const pushCalls = shellCalls.filter((entry) => gitOperation(entry.command, 'push'));
  const exportCalls = shellCalls.filter((entry) =>
    isCompletionPackageExportCommand(entry.command, target.cliCommand));
  const notificationChecks = exactCalls(workflowCalls, 'get_notifications');

  if (targetName === 'declined') {
    assert.deepStrictEqual(mutations.map(workflowToolName), ['add_info'],
      'A none selection may only create its terminal accepted-selection record');
    const selectionRecord = mutations[0];
    assert.strictEqual(selectionRecord.input?.short_code_id, target.reviewCode,
      'Declined chat selection must be acknowledged on the exact review');
    assertPackageState(selectionRecord, {
      source: 'agent',
      selection: 'none',
      selected: [],
      completed: [],
      remaining: [],
      label: 'Declined accepted-selection record'
    });
    assert(reviewLoads.some((call) => call.resultEventIndex < selectionRecord.eventIndex),
      'Declined package must inspect the review before accepting the chat response');
    const selectionCode = createdCommentCode(
      parsed, selectionRecord, 'Declined accepted-selection record'
    );
    const reconciledLoads = reviewLoads.filter((call) =>
      selectionRecord.resultEventIndex < call.eventIndex &&
      resultTexts(parsed, call).some((text) => text.includes(selectionCode)));
    assert(reconciledLoads.length > 0,
      'Declined package must reload the review and confirm its durable chat record');
    assertReferenceLoaded(
      parsed,
      expectedSkillFiles,
      'references/operations.md',
      selectionRecord.eventIndex,
      'Declined completion operations reference'
    );
    assert.deepStrictEqual(commitCalls, [], 'Declined completion package must not commit');
    assert.deepStrictEqual(pushCalls, [], 'Declined completion package must not push');
    assert.deepStrictEqual(exportCalls, [], 'Declined completion package must not export');
    assert.deepStrictEqual(notificationChecks, [],
      'Declined completion package has no completion action requiring an inbox check');
    const restoredBoundary = Math.max(
      ...doableReloads.map((call) => call.resultEventIndex),
      ...reconciledLoads.map((call) => call.resultEventIndex)
    );
    assertNoPrematureLaneSwitch(workflowCalls, allowedCodes, restoredBoundary);
    return;
  }

  const expectedMutations = targetName === 'partial'
    ? ['add_info']
    : ['add_info', 'clear_notifications', 'change_job_stage', 'add_info', 'add_info'];
  assert.deepStrictEqual(mutations.map(workflowToolName), expectedMutations,
    `${targetName} completion package performed an unauthorized or misordered mutation`);
  assert.strictEqual(commitCalls.length, 1,
    `${targetName} completion package must issue one commit command`);
  const commit = commitCalls[0];
  assert.strictEqual(commit.call.success, true,
    `${targetName} task-owned commit command must succeed`);

  if (targetName === 'partial') {
    assert(doableReloads.some((call) => call.resultEventIndex < commit.call.eventIndex),
      'Partial package must reload the exact job and assistance before committing');
    assert(reviewLoads.some((call) => call.resultEventIndex < commit.call.eventIndex &&
      resultTexts(parsed, call).some((text) => text.includes(target.reviewReplyCode))),
    'Partial package must observe the earlier human review reply before committing');
    assertReferenceLoaded(
      parsed,
      expectedSkillFiles,
      'references/operations.md',
      commit.call.eventIndex,
      'Partial completion operations reference'
    );
    assert.deepStrictEqual(pushCalls, [], 'Partial completion package must not push');
    assert.deepStrictEqual(exportCalls, [], 'Partial completion package must not export');
    const lateChecks = notificationChecks.filter((call) =>
      commit.call.resultEventIndex < call.eventIndex);
    assert(lateChecks.length > 0,
      'Partial completion package must perform a fresh inbox check after its commit');
    assert(commit.call.resultEventIndex < lateChecks[0].eventIndex,
      'Partial completion package must check notifications after its authorized commit');
    assert(resultTexts(parsed, lateChecks[0]).some((text) =>
      text.includes(target.notificationCode) && text.includes(target.reviewCode)),
      'Partial completion package must list its exact nested and review notifications');
    const terminalStatus = mutations[0];
    assert.strictEqual(terminalStatus.input?.short_code_id, target.reviewReplyCode,
      'Partial terminal status must use the human review reply as its state root');
    assertPackageState(terminalStatus, {
      completed: [1],
      remaining: [],
      label: 'Partial terminal package status'
    });
    assert(lateChecks[0].resultEventIndex < terminalStatus.eventIndex,
      'Partial package must record terminal status after its final required check');
    assert.deepStrictEqual(exactCalls(workflowCalls, 'clear_notifications'), [],
      'Partial completion package must not clear notifications without authorization');
    assertNoPrematureLaneSwitch(
      workflowCalls,
      allowedCodes,
      terminalStatus.resultEventIndex
    );
    return;
  }

  const selectionRecord = mutations[0];
  assert.strictEqual(selectionRecord.input?.short_code_id, target.reviewCode,
    'Full chat selection must be acknowledged on the exact review');
  assertPackageState(selectionRecord, {
    source: 'agent',
    selection: 'all',
    selected: [1, 2, 3, 4],
    completed: [],
    remaining: [1, 2, 3, 4],
    label: 'Full accepted-selection record'
  });
  assert(reviewLoads.some((call) => call.resultEventIndex < selectionRecord.eventIndex),
    'Full package must inspect the review before accepting the chat response');
  const selectionCode = createdCommentCode(
    parsed, selectionRecord, 'Full accepted-selection record'
  );
  const reconciledLoads = reviewLoads.filter((call) =>
    selectionRecord.resultEventIndex < call.eventIndex &&
    call.resultEventIndex < commit.call.eventIndex &&
    resultTexts(parsed, call).some((text) => text.includes(selectionCode)));
  assert(reconciledLoads.length > 0,
    'Full package must reconcile its durable chat record before committing');
  assert(doableReloads.some((call) => call.resultEventIndex < commit.call.eventIndex),
    'Full package must reload the exact job and assistance before committing');
  assertReferenceLoaded(
    parsed,
    expectedSkillFiles,
    'references/operations.md',
    selectionRecord.eventIndex,
    'Full completion operations reference'
  );
  assert.strictEqual(pushCalls.length, 1,
    'Full completion package must issue one push command');
  const push = pushCalls[0];
  assert.strictEqual(push.call.success, true,
    'Full completion package push command must succeed');
  if (push.call === commit.call) {
    assert(gitOperationIndex(commit.command, 'commit') <
      gitOperationIndex(push.command, 'push'),
      'Combined full-package shell command must place commit before push');
  } else {
    assert(commit.call.resultEventIndex < push.call.eventIndex,
      'Full completion package must finish commit before push');
  }
  const clear = mutations[1];
  const stage = mutations[2];
  const sweep = mutations[3];
  const terminalStatus = mutations[4];
  const lateChecks = notificationChecks.filter((call) =>
    push.call.resultEventIndex < call.eventIndex && call.resultEventIndex < clear.eventIndex);
  assert(lateChecks.length > 0,
    'Full completion package must freshly check notifications after push and before clear');
  const freshCheck = lateChecks.at(-1);
  assert(resultTexts(parsed, freshCheck).some((text) =>
    text.includes(target.notificationCode)),
    'Full completion package must list its seeded nested notification before clearing');
  if (target.reviewCode) {
    assert(resultTexts(parsed, freshCheck).some((text) => text.includes(target.reviewCode)),
      'Full completion package must list its auto-opened review notification before clearing');
  }
  assertExactInput(clear, { short_code_id: target.jobCode },
    'Full completion package notification clear');
  assert(freshCheck.resultEventIndex < clear.eventIndex,
    'Full completion package must finish listing notifications before clearing');
  assertExactInput(stage, { job_id: target.jobCode, stage: 'Reviewable' },
    'Full completion package stage transition');
  assert(clear.resultEventIndex < stage.eventIndex,
    'Full completion package must clear exact-job notifications before Reviewable');
  const preStageReloads = exactCalls(workflowCalls, 'get_job').filter((call) =>
    call.input?.short_code_id === target.jobCode &&
    clear.resultEventIndex < call.eventIndex && call.resultEventIndex < stage.eventIndex);
  assert(preStageReloads.length > 0,
    'Full completion package must freshly reload the exact job after clear and before Reviewable');
  assert(preStageReloads.some((call) => resultTexts(parsed, call).some((text) =>
    text.includes('This job is in stage Doable.'))),
    'Full completion package pre-stage reload must still observe exact-job Doable state');
  assert.strictEqual(exportCalls.length, 1,
    'Full completion package must run one fresh workspace export');
  const exportCall = exportCalls[0];
  assert.strictEqual(exportCall.call.success, true,
    'Full completion-package workspace export must succeed');
  assert(!/(?:^|\s)(?:-o|--output)(?:\s|=|$)/.test(exportCall.command),
    'Completion sweep must use the configured export destination without an output override');
  assert(stage.resultEventIndex < exportCall.call.eventIndex,
    'Full completion package must enter Reviewable before running its sweep export');
  assertReferenceLoaded(
    parsed,
    expectedSkillFiles,
    'references/completion.md',
    exportCall.call.eventIndex,
    'Full completion-sweep reference'
  );
  const relativeExportPath = target.exportFile.slice(
    target.exportFile.lastIndexOf('/.agent-dev-export/') + 1
  );
  const exportReads = shellCalls.filter(({ call, command }) =>
    call.success === true &&
    exportCall.call.resultEventIndex < call.eventIndex &&
    call.resultEventIndex < sweep.eventIndex &&
    (command.includes(target.exportFile) || command.includes(relativeExportPath)) &&
    /\b(?:awk|cat|grep|head|rg|sed|tail)\b/.test(command));
  assert(exportReads.length > 0,
    'Completion sweep must read or search the newly written export before recording results');
  assert.strictEqual(sweep.input?.short_code_id, target.jobCode,
    'Completion sweep result must be recorded on the exact triggering job');
  assert.strictEqual(typeof sweep.input?.info, 'string',
    'Completion sweep result must contain durable evidence');
  assert(sweep.input.info.includes(target.noCandidates),
    'Completion sweep must record the explicit no-candidate result');
  assert(exportCall.call.resultEventIndex < sweep.eventIndex,
    'Completion sweep must finish its fresh export before recording the result');
  assert.strictEqual(terminalStatus.input?.short_code_id, selectionCode,
    'Full terminal status must reply to its accepted chat-selection record');
  assertPackageState(terminalStatus, {
    completed: [1, 2, 3, 4],
    remaining: [],
    label: 'Full terminal package status'
  });
  assert(sweep.resultEventIndex < terminalStatus.eventIndex,
    'Full package must record terminal status only after its completion sweep');
  assertNoPrematureLaneSwitch(workflowCalls, allowedCodes, terminalStatus.resultEventIndex);
}
