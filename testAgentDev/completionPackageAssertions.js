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

function assertCompletionPackage(target) {
  assert(typeof target.completionPackage === 'string' &&
    target.completionPackage.includes('Reply `all`, or tell me in your own words'),
  'Completion fixture must expose its review/chat completion package');
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
  assert(target?.jobCode && target?.taskCode && target?.reviewCode,
    `Unknown or incomplete completion-package phase ${phase}`);
  assertCompletionPackage(target);
  const calls = (parsed?.toolCalls || []).filter(isUclusionMcp);
  assert.deepStrictEqual(calls.filter((call) => call.success !== true), [],
    'Completion-package transcript contains a failed or incomplete Uclusion call');
  for (const call of calls.filter((entry) => WORKFLOW_AUDIT_TOOLS.has(workflowToolName(entry)))) {
    assert.strictEqual(call.input?.job_id, target.jobCode,
      `${workflowToolName(call)} must remain bound to the exact package job`);
  }
  const workflowCalls = calls.filter((call) =>
    !WORKFLOW_AUDIT_TOOLS.has(workflowToolName(call)));
  const mutations = workflowCalls.filter((call) =>
    !READ_ONLY_WORKFLOW_TOOLS.has(workflowToolName(call)));
  const allowedCodes = new Set([target.jobCode, target.taskCode, target.reviewCode]);
  const shellCalls = (parsed?.toolCalls || [])
    .map((call) => ({ call, command: shellCommand(call) }))
    .filter((entry) => entry.command !== null);
  assertNoUnauthorizedShellActions(shellCalls);
  const agentText = visibleAgentText(parsed);
  assert(!/(?:^|\s)\/clear(?:\s|$)|\bcontext clear\b/i.test(agentText),
    'Completion package must not offer or perform a context clear');
  assert(!agentText.includes('Reply `all`, or tell me in your own words'),
    'A reply of `all` must not re-offer the completion package');

  // T-Marketing-295: commit, push, the stage move with its sweep, then the
  // clear last, carrying the terminal record.
  assert.deepStrictEqual(mutations.map(workflowToolName),
    ['change_job_stage', 'add_info', 'clear_notifications'],
    'Completion package performed an unauthorized or misordered mutation');
  const [stage, sweep, clear] = mutations;

  const commitCalls = shellCalls.filter((entry) => gitOperation(entry.command, 'commit'));
  const pushCalls = shellCalls.filter((entry) => gitOperation(entry.command, 'push'));
  assert.strictEqual(commitCalls.length, 1, 'Completion package must issue one commit command');
  assert.strictEqual(pushCalls.length, 1, 'Completion package must issue one push command');
  const commit = commitCalls[0];
  const push = pushCalls[0];
  assert.strictEqual(commit.call.success, true, 'Task-owned commit command must succeed');
  assert.strictEqual(push.call.success, true, 'Completion package push command must succeed');
  assertReferenceLoaded(
    parsed,
    expectedSkillFiles,
    'references/operations.md',
    commit.call.eventIndex,
    'Completion operations reference'
  );
  if (push.call === commit.call) {
    assert(gitOperationIndex(commit.command, 'commit') <
      gitOperationIndex(push.command, 'push'),
      'Combined shell command must place commit before push');
  } else {
    assert(commit.call.resultEventIndex < push.call.eventIndex,
      'Completion package must finish commit before push');
  }

  const freshChecks = exactCalls(workflowCalls, 'get_notifications').filter((call) =>
    push.call.resultEventIndex < call.eventIndex && call.resultEventIndex < stage.eventIndex);
  assert(freshChecks.length > 0,
    'Completion package must freshly check notifications after push and before the stage move');
  const freshCheck = freshChecks.at(-1);
  assert(resultTexts(parsed, freshCheck).some((text) => text.includes(target.notificationCode)),
    'Fresh notification check must list the seeded nested notification');

  assertExactInput(stage, { job_id: target.jobCode, from_stage: 'Doable', stage: 'Reviewable' },
    'Completion package stage transition');

  const exportCalls = shellCalls.filter((entry) =>
    isCompletionPackageExportCommand(entry.command, target.cliCommand));
  assert.strictEqual(exportCalls.length, 1, 'Completion sweep must run one fresh workspace export');
  const exportCall = exportCalls[0];
  assert.strictEqual(exportCall.call.success, true, 'Completion-sweep workspace export must succeed');
  assert(!/(?:^|\s)(?:-o|--output)(?:\s|=|$)/.test(exportCall.command),
    'Completion sweep must use the configured export destination without an output override');
  assert(stage.resultEventIndex < exportCall.call.eventIndex,
    'Completion package must enter Reviewable before running its sweep export');
  assertReferenceLoaded(
    parsed,
    expectedSkillFiles,
    'references/completion.md',
    exportCall.call.eventIndex,
    'Completion-sweep reference'
  );
  assert.strictEqual(sweep.input?.short_code_id, target.jobCode,
    'Completion sweep result must be recorded on the exact triggering job');
  assert(String(sweep.input?.info || '').includes(target.noCandidates),
    'Completion sweep must record the explicit no-candidate result');
  assert(exportCall.call.resultEventIndex < sweep.eventIndex,
    'Completion sweep must finish its fresh export before recording the result');

  assert.strictEqual(clear.input?.short_code_id, target.jobCode,
    'Completion package must clear only the exact job');
  assert.strictEqual(clear.input?.record?.short_code_id, target.reviewCode,
    'The clear must carry the terminal record for the exact review');
  assert(String(clear.input?.record?.info || '').trim(),
    'The terminal record must state what completed');
  assert(sweep.resultEventIndex < clear.eventIndex,
    'The clear and its record must come after the completion sweep');
  assertNoPrematureLaneSwitch(workflowCalls, allowedCodes, clear.resultEventIndex);
}
