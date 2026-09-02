import assert from 'assert';
import {
  ONBOARDING_COLLABORATOR_EMAIL,
  ONBOARDING_VIEW_NAME
} from './onboardingScenarios.js';
import { mcpResultTexts } from './trace.js';

export const MAX_CODEX_REPORTED_TOKENS = 500000;

const ONBOARDING_GUIDANCE_MARKER = 'Offer view and collaborator setup first';

function completedCodexItems(events) {
  return (events || [])
    .filter((event) => event?.type === 'item.completed' && event.item)
    .map((event) => event.item);
}

function codexMcpResultTexts(events, tool) {
  return completedCodexItems(events)
    .filter((item) => ['mcp_tool_call', 'mcp_call'].includes(item.type))
    .filter((item) =>
      String(item.tool || item.tool_name || item.name || '').toLowerCase() === tool)
    .flatMap((item) => mcpResultTexts(item.result?.content));
}

function codexUserVisibleTexts(events) {
  return completedCodexItems(events)
    .filter((item) => item.type === 'agent_message' && typeof item.text === 'string')
    .map((item) => item.text);
}

function requiredTokenCount(usage, name) {
  const value = usage?.[name];
  assert(Number.isSafeInteger(value) && value >= 0,
    `Codex reported usage is missing a nonnegative integer ${name}`);
  return value;
}

export function reportedCodexTotalUsage(reportedUsage) {
  const usage = reportedUsage?.usage;
  assert(usage && typeof usage === 'object' && !Array.isArray(usage),
    'Codex invocation did not report turn.completed usage');
  const input = requiredTokenCount(usage, 'input_tokens');
  const output = requiredTokenCount(usage, 'output_tokens');
  const total = input + output;
  assert(Number.isSafeInteger(total), 'Codex reported usage total is not a safe integer');
  return total;
}

export function assertCodexUsageWithinCeiling(
  reportedUsage,
  ceiling = MAX_CODEX_REPORTED_TOKENS
) {
  assert(Number.isSafeInteger(ceiling) && ceiling > 0,
    'Codex usage ceiling must be a positive safe integer');
  const total = reportedCodexTotalUsage(reportedUsage);
  assert(total <= ceiling,
    `Codex invocation reported ${total} tokens, exceeding the ${ceiling}-token ceiling`);
  return total;
}

function isUclusionMcp(call) {
  const name = String(call?.name || '').toLowerCase();
  return name.startsWith('mcp__uclusion__') || name.startsWith('uclusion.');
}

function semanticToolName(call) {
  const name = String(call?.name || '').toLowerCase();
  if (name.startsWith('mcp__uclusion__')) {
    return name.slice('mcp__uclusion__'.length);
  }
  if (name.startsWith('uclusion.')) {
    return name.slice('uclusion.'.length);
  }
  return null;
}

function exactInput(call, expected, label) {
  assert.deepStrictEqual(call.input, expected,
    `${label} must use the exact durable short code and argument shape`);
}

const WORKFLOW_AUDIT_TOOLS = new Set([
  'start_job_audit',
  'set_job_audit_phase',
  'end_job_audit'
]);

const READ_ONLY_WORKFLOW_TOOLS = new Set([
  'get_job',
  'find_work',
  'get_notifications'
]);

const CODEX_SKILL_RELATIVE_PATH = '.agents/skills/uclusion/SKILL.md';
const SHELL_READERS = new Set([
  'awk',
  'bat',
  'cat',
  'grep',
  'head',
  'less',
  'more',
  'nl',
  'rg',
  'sed',
  'tail'
]);

function normalizedPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function shellTokens(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  const finish = () => {
    if (token) {
      tokens.push(token);
      token = '';
    }
  };
  for (const character of String(command || '')) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character) || /[;&|()<>]/.test(character)) {
      finish();
    } else {
      token += character;
    }
  }
  if (escaped) {
    token += '\\';
  }
  finish();
  return tokens;
}

function splitUnquotedReadCommands(command) {
  const parts = [];
  let part = '';
  let quote = null;
  let escaped = false;
  const text = String(command || '');
  const pushPart = () => {
    if (!part.trim()) {
      return false;
    }
    parts.push(part.trim());
    part = '';
    return true;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      part += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      part += character;
      escaped = true;
    } else if (quote) {
      part += character;
      if (character === quote) {
        quote = null;
      }
    } else if (character === "'" || character === '"') {
      part += character;
      quote = character;
    } else if (character === '&' && text[index + 1] === '&') {
      if (!pushPart()) {
        return null;
      }
      index += 1;
    } else if (character === ';') {
      // Live agents chain read-only probes with ';' as readily as '&&';
      // both separate whole commands. Reject ';;' and empty segments.
      if (text[index + 1] === ';' || !pushPart()) {
        return null;
      }
    } else if (character === '\n') {
      // A newline separates commands like ';' but may also be blank.
      if (part.trim()) {
        parts.push(part.trim());
        part = '';
      } else {
        part = '';
      }
    } else if (/[&|()<>]/.test(character)) {
      return null;
    } else if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return null;
    } else {
      part += character;
    }
  }
  if (quote !== null || escaped) {
    return null;
  }
  if (part.trim()) {
    parts.push(part.trim());
  }
  return parts.length ? parts : null;
}

const SHELL_FLOW_KEYWORDS = ['if', 'then', 'else', 'elif', 'do'];
const SHELL_FLOW_TERMINATORS = new Set(['fi', 'done']);

// Strip leading flow keywords so `if [ ... ]` grades as its probe and bare
// terminators grade as empty; unknown flow (while, for, case) stays intact
// and fails closed downstream.
function strippedFlowPart(part) {
  let current = String(part || '').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const keyword of SHELL_FLOW_KEYWORDS) {
      if (current === keyword) {
        return '';
      }
      if (current.startsWith(`${keyword} `)) {
        current = current.slice(keyword.length + 1).trim();
        changed = true;
      }
    }
  }
  return SHELL_FLOW_TERMINATORS.has(current) ? '' : current;
}

// A compound read may include silent or short-output probes, such as the
// bridge-presence check the stub itself requires, as long as no probe can
// fabricate staged skill content into the credited output.
function isHarmlessProbePart(part, expectedSkillContent) {
  const tokens = shellTokens(part);
  let index = 0;
  while (index < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  const executable = normalizedPath(tokens[index]).split('/').at(-1);
  if (['test', '['].includes(executable)) {
    return true;
  }
  // printf and echo may emit their arguments; wc, stat, and ls emit counts,
  // metadata, and names derived from their arguments. All are safe exactly
  // when no argument token could reproduce staged skill content.
  if (!['printf', 'echo', 'wc', 'stat', 'ls'].includes(executable)) {
    return false;
  }
  return tokens.slice(index + 1).every((token) =>
    token.length < 8 || !expectedSkillContent.includes(token));
}

function exactSkillPathReference(
  value,
  expectedSkillPath,
  expectedSkillRelativePath = CODEX_SKILL_RELATIVE_PATH
) {
  const candidate = normalizedPath(value);
  const expected = normalizedPath(expectedSkillPath);
  return candidate === expected || candidate === normalizedPath(expectedSkillRelativePath);
}

function isStaticBannerCommand(command, expectedSkillContent) {
  const tokens = shellTokens(command);
  if (tokens.length !== 2 ||
      normalizedPath(tokens[0]).split('/').at(-1) !== 'printf') {
    return false;
  }
  const match = tokens[1].match(/^\\n---([A-Z][A-Z0-9 _-]{0,63})---\\n$/);
  return Boolean(match) &&
    !expectedSkillContent.includes(`---${match[1]}---`);
}

function isSimpleExactSkillReadCommand(
  command,
  expectedSkillPath,
  expectedSkillContent,
  expectedSkillRelativePath = CODEX_SKILL_RELATIVE_PATH,
  depth = 0
) {
  if (depth > 1) {
    return false;
  }
  const parts = splitUnquotedReadCommands(command);
  if (!parts) {
    return false;
  }
  if (parts.length > 1) {
    const reader = (part) => {
      const partTokens = shellTokens(part);
      let partExecutableIndex = 0;
      while (partExecutableIndex < partTokens.length &&
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(partTokens[partExecutableIndex])) {
        partExecutableIndex += 1;
      }
      const partExecutable = normalizedPath(partTokens[partExecutableIndex])
        .split('/').at(-1);
      return SHELL_READERS.has(partExecutable);
    };
    const strippedParts = parts.map(strippedFlowPart).filter(Boolean);
    return strippedParts.length > 0 && strippedParts.every((part) =>
      reader(part) || isStaticBannerCommand(part, expectedSkillContent) ||
        isHarmlessProbePart(part, expectedSkillContent)) &&
      strippedParts.some((part) =>
        isSimpleExactSkillReadCommand(
          part,
          expectedSkillPath,
          expectedSkillContent,
          expectedSkillRelativePath,
          depth
        ));
  }
  const tokens = shellTokens(command);
  let executableIndex = 0;
  while (executableIndex < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[executableIndex])) {
    executableIndex += 1;
  }
  const executable = normalizedPath(tokens[executableIndex]).split('/').at(-1);
  if (['bash', 'dash', 'sh', 'zsh'].includes(executable)) {
    const commandFlagIndex = tokens.findIndex((token, index) =>
      index > executableIndex && /^-[^-]*c/.test(token));
    return commandFlagIndex !== -1 && tokens[commandFlagIndex + 1] !== undefined &&
      isSimpleExactSkillReadCommand(
        tokens[commandFlagIndex + 1],
        expectedSkillPath,
        expectedSkillContent,
        expectedSkillRelativePath,
        depth + 1
      );
  }
  return SHELL_READERS.has(executable) && tokens.slice(executableIndex + 1)
    .some((token) => exactSkillPathReference(
      token,
      expectedSkillPath,
      expectedSkillRelativePath
    ));
}

function referencesExactSkillRead(
  read,
  expectedSkillPath,
  expectedSkillContent,
  expectedSkillRelativePath
) {
  const name = String(read?.name || '').toLowerCase();
  if (name === 'read' || name === 'read_file') {
    return exactSkillPathReference(
      read.input?.path ?? read.input?.file_path,
      expectedSkillPath,
      expectedSkillRelativePath
    );
  }
  if (!['shell', 'bash', 'exec_command', 'command_execution'].includes(name)) {
    return false;
  }
  const command = read.input?.command ?? read.input?.cmd;
  return isSimpleExactSkillReadCommand(
    Array.isArray(command) ? command.join(' ') : command,
    expectedSkillPath,
    expectedSkillContent,
    expectedSkillRelativePath
  );
}

function exactCoverageIntervals(expected, fragment) {
  if (!fragment) {
    return [];
  }
  if (fragment.includes(expected)) {
    return [[0, expected.length]];
  }
  const substringIntervals = (candidate) => {
    const intervals = [];
    let offset = 0;
    while (offset <= expected.length - candidate.length) {
      const start = expected.indexOf(candidate, offset);
      if (start === -1) {
        break;
      }
      intervals.push([start, start + candidate.length]);
      offset = start + 1;
    }
    return intervals;
  };
  const direct = substringIntervals(fragment);
  if (direct.length) {
    return direct;
  }
  // A safe compound read can concatenate another reference before or after
  // the skill chunk. Attribute only the longest exact, newline-aligned edge
  // that is byte-for-byte present in the staged skill.
  const newlineEnds = [...fragment.matchAll(/\n/g)].map((match) => match.index + 1);
  for (const end of newlineEnds.reverse()) {
    const intervals = substringIntervals(fragment.slice(0, end));
    if (intervals.length) {
      return intervals;
    }
  }
  const newlineStarts = [0, ...[...fragment.matchAll(/\n/g)]
    .map((match) => match.index + 1)];
  for (const start of newlineStarts) {
    const intervals = substringIntervals(fragment.slice(start));
    if (intervals.length) {
      return intervals;
    }
  }
  return [];
}

function fragmentsCoverExactContent(fragments, expected) {
  const intervals = fragments
    .flatMap((fragment) => exactCoverageIntervals(expected, fragment))
    .sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let coveredThrough = 0;
  for (const [start, end] of intervals) {
    if (start > coveredThrough) {
      break;
    }
    coveredThrough = Math.max(coveredThrough, end);
    if (coveredThrough === expected.length) {
      return true;
    }
  }
  return false;
}

function exactTargetReloads(calls, shortCode, label) {
  assert(typeof shortCode === 'string' && shortCode.trim(),
    `${label} is missing its exact durable target`);
  const reloads = calls.filter((call) => semanticToolName(call) === 'get_job');
  const exact = reloads.filter((call) => call.input?.short_code_id === shortCode);
  assert(exact.length > 0, `${label} must call get_job on exact ${shortCode}`);
  return exact;
}

function assertExplainedOptionVote(call, { optionCodes, questionCode, label }) {
  const approval = call.input;
  assert(approval && typeof approval === 'object' && !Array.isArray(approval),
    `${label} option approval input must be an object`);
  assert.deepStrictEqual(Object.keys(approval).sort(), [
    'certainty',
    'job_or_option_id',
    'parent_question_short_code_id',
    'reason'
  ], `${label} option approval must contain the exact explained-vote fields`);
  assert(Array.isArray(optionCodes) && optionCodes.length === 2 &&
    new Set(optionCodes).size === 2,
  `${label} is missing the two exact durable option codes`);
  assert(optionCodes.includes(approval.job_or_option_id),
    `${label} must vote on one of the exact question options`);
  assert.strictEqual(approval.parent_question_short_code_id, questionCode,
    `${label} option vote must name the exact parent question`);
  assert(Number.isInteger(approval.certainty) && approval.certainty >= 1 &&
    approval.certainty <= 5,
  `${label} option vote certainty must be an integer from one through five`);
  assert(typeof approval.reason === 'string' && approval.reason.trim(),
    `${label} must explain its option vote`);
}

export function assertFileLoadedBeforeEvent(parsed, {
  expectedPath,
  expectedContent,
  expectedRelativePath,
  expectedStartSentinel,
  expectedEndSentinel,
  beforeEventIndex,
  label = 'Semantic staged file'
} = {}) {
  assert(typeof expectedPath === 'string' && expectedPath.trim(),
    `${label} proof requires the exact staged path`);
  assert(typeof expectedRelativePath === 'string' && expectedRelativePath.trim(),
    `${label} proof requires the client-relative path`);
  const normalizedExpected = normalizedPath(expectedRelativePath);
  const normalizedAbsolute = normalizedPath(expectedPath);
  assert(normalizedAbsolute === normalizedExpected ||
    normalizedAbsolute.endsWith(`/${normalizedExpected}`),
  `${label} proof path must end in ${normalizedExpected}`);
  assert(typeof expectedContent === 'string' && expectedContent,
    `${label} proof requires the exact full staged content`);
  if (expectedStartSentinel !== undefined) {
    assert(typeof expectedStartSentinel === 'string' && expectedStartSentinel,
      `${label} proof requires a valid entry sentinel`);
    assert(expectedContent.includes(expectedStartSentinel),
      `${label} staged content does not contain its required entry sentinel`);
  }
  assert(typeof expectedEndSentinel === 'string' && expectedEndSentinel,
    `${label} proof requires its EOF sentinel`);
  assert(expectedContent.trimEnd().endsWith(expectedEndSentinel),
    `${label} staged content does not end in its required EOF sentinel`);
  assert(Number.isSafeInteger(beforeEventIndex) && beforeEventIndex >= 0,
    `${label} proof requires a valid event boundary`);
  const exactReads = (parsed?.successfulReadEvidence || []).filter((read) =>
    read.eventIndex < beforeEventIndex && read.resultEventIndex < beforeEventIndex &&
    referencesExactSkillRead(
      read,
      expectedPath,
      expectedContent,
      expectedRelativePath
    ));
  assert(exactReads.length > 0,
    `${label} trace has no successful read of the exact staged path before its boundary`);
  const fragments = exactReads.flatMap((read) => read.fragments
    .filter((fragment) => fragment.eventIndex < beforeEventIndex)
    .map((fragment) => fragment.text));
  if (expectedStartSentinel !== undefined) {
    assert(fragments.some((fragment) => fragment.includes(expectedStartSentinel)),
      `${label} trace never exposed its literal entry sentinel before the boundary`);
  }
  assert(fragments.some((fragment) => fragment.includes(expectedEndSentinel)),
    `${label} trace never exposed its literal EOF sentinel before the boundary`);
  assert(fragmentsCoverExactContent(fragments, expectedContent),
    `${label} reads did not cover its exact full content through EOF`);
}

export function assertSkillLoadedBeforeSemanticMcp(parsed, {
  expectedSkillPath,
  expectedSkillContent
} = {}) {
  assert(typeof parsed?.skillEndSentinel === 'string' && parsed.skillEndSentinel,
    'Semantic trace parser omitted the required skill EOF sentinel');
  const mcpCalls = (parsed?.toolCalls || []).filter(isUclusionMcp);
  assert(mcpCalls.length > 0, 'Semantic Codex trace contains no Uclusion MCP call');
  const firstMcpIndex = Math.min(...mcpCalls.map((call) => call.eventIndex));
  const sentinelIndexes = parsed?.sentinelEventIndexes || [];
  assert(sentinelIndexes.length > 0,
    `Semantic Codex trace never exposed the literal ` +
      `${parsed?.skillEndSentinel || 'skill EOF sentinel'}`);
  assert(Math.min(...sentinelIndexes) < firstMcpIndex,
    'The literal shipped Uclusion skill EOF sentinel must load before the first semantic MCP call');
  assertFileLoadedBeforeEvent(parsed, {
    expectedPath: expectedSkillPath,
    expectedContent: expectedSkillContent,
    expectedRelativePath: CODEX_SKILL_RELATIVE_PATH,
    expectedEndSentinel: parsed.skillEndSentinel,
    beforeEventIndex: firstMcpIndex,
    label: 'Semantic Uclusion skill'
  });
}

export function assertSemanticTranscript({
  phase,
  parsed,
  targets,
  expectedSkillPath,
  expectedSkillContent
}) {
  assertSkillLoadedBeforeSemanticMcp(parsed, {
    expectedSkillPath,
    expectedSkillContent
  });
  const calls = (parsed?.toolCalls || []).filter(isUclusionMcp);
  assert.deepStrictEqual(calls.filter((call) => call.success !== true), [],
    'Semantic transcript contains a failed or incomplete Uclusion call');
  const semanticCalls = calls.filter((call) =>
    !WORKFLOW_AUDIT_TOOLS.has(semanticToolName(call)));
  // T-all-2465: economical loading exists to prevent duplication. The first
  // get_job of a short code may take its whole scope; any repeat load of the
  // same code in one live process must be scoped with thread_only or
  // nonempty sections instead of pulling the whole job again.
  const unscopedLoads = new Map();
  for (const call of semanticCalls.filter((entry) => semanticToolName(entry) === 'get_job')) {
    const scoped = call.input?.thread_only === true ||
      (Array.isArray(call.input?.sections) && call.input.sections.length > 0);
    if (scoped) {
      continue;
    }
    const code = call.input?.short_code_id;
    const count = (unscopedLoads.get(code) || 0) + 1;
    unscopedLoads.set(code, count);
    assert(count <= 1,
      `An item poke must not duplicate context: ${code} was fully loaded ` +
        `${count} times in one live process`);
  }
  // Treat every non-audit tool as state-changing unless it is explicitly
  // known to be read-only. This fails closed if the MCP surface grows.
  const mutations = semanticCalls.filter((call) =>
    !READ_ONLY_WORKFLOW_TOOLS.has(semanticToolName(call)));

  if (phase === 'advisory-stop') {
    const reloads = exactTargetReloads(semanticCalls, targets.questionCode, 'Advisory-only authority check');
    const mutationNames = mutations.map(semanticToolName);
    assert(
      mutationNames.length <= 1 &&
        mutationNames.every((name) => name === 'approve_job_or_option'),
      'Advisory-only authority check may only make one well-bound AI option-vote update from advisory input'
    );
    if (mutations.length === 1) {
      assert(Math.min(...reloads.map((call) => call.resultEventIndex)) <
        mutations[0].eventIndex,
      'Advisory-only authority check must load the exact parent question before changing its AI vote');
      assertExplainedOptionVote(mutations[0], {
        optionCodes: targets.authorityOptionCodes,
        questionCode: targets.questionCode,
        label: 'Advisory-only authority check'
      });
    }
    return;
  }

  if (phase === 'primary-resume') {
    const reloads = exactTargetReloads(semanticCalls, targets.questionCode, 'Primary-answer resolution and continuation');
    const mutationNames = mutations.map(semanticToolName);
    const includesVote = mutationNames[0] === 'approve_job_or_option';
    assert.deepStrictEqual(
      mutationNames,
      includesVote ? ['approve_job_or_option', 'resolve', 'resolve'] : ['resolve', 'resolve'],
      'Primary-answer resolution and continuation may update its option vote, then must resolve exactly the Q and T'
    );
    const questionResolve = mutations[includesVote ? 1 : 0];
    const taskResolve = mutations[includesVote ? 2 : 1];
    if (includesVote) {
      assertExplainedOptionVote(mutations[0], {
        optionCodes: targets.authorityOptionCodes,
        questionCode: targets.questionCode,
        label: 'Primary-answer resolution and continuation'
      });
      assert(mutations[0].eventIndex < questionResolve.eventIndex,
        'Primary-answer resolution and continuation must update any AI vote before resolving the question');
    }
    exactInput(questionResolve, { short_code_id: targets.questionCode },
      'Primary-answer resolution and continuation question resolve');
    exactInput(taskResolve, { short_code_id: targets.taskCode },
      'Primary-answer resolution and continuation task resolve');
    assert(Math.min(...reloads.map((call) => call.resultEventIndex)) <
      mutations[0].eventIndex,
    'Primary-answer resolution and continuation must load the exact parent question before voting or resolving it');
    assert(questionResolve.eventIndex < taskResolve.eventIndex,
      'Primary-answer resolution and continuation must resolve the question before continuing to the task');
    assert(!mutations.some((call) => call.input?.short_code_id === targets.authorityJobCode),
      'Primary-answer resolution and continuation must never resolve the enclosing authority job');
    return;
  }

  if (phase === 'bug-conversion') {
    const reloads = exactTargetReloads(semanticCalls, targets.bugCode, 'Standalone-bug conversion');
    assert.match(targets.bugJobCode || '', /^J-/,
      'Standalone-bug conversion is missing the exact converted Bugs job code');
    const convertedJobReloads = exactTargetReloads(
      semanticCalls,
      targets.bugJobCode,
      'Standalone-bug conversion converted Bugs job'
    );
    assert.deepStrictEqual(
      mutations.map(semanticToolName),
      ['ask_question', 'approve_job_or_option'],
      'Standalone-bug conversion must ask once and cast exactly one required option vote'
    );
    assert(Math.min(...reloads.map((call) => call.resultEventIndex)) < mutations[0].eventIndex,
      'Standalone-bug conversion must load the exact standalone bug before asking on it');
    const question = mutations[0].input;
    assert(question && typeof question === 'object' && !Array.isArray(question),
      'Standalone-bug conversion ask_question input must be an object');
    assert.deepStrictEqual(Object.keys(question).sort(), ['job_id', 'name', 'options', 'question'],
      'Standalone-bug conversion ask_question must contain only job_id, name, question, and options');
    assert.strictEqual(question.job_id, targets.bugCode,
      'Standalone-bug conversion ask_question must target the exact standalone bug');
    assert.strictEqual(question.name, targets.bugJobName,
      'Standalone-bug conversion ask_question must pass the exact requested job name');
    assert.strictEqual(typeof question.question, 'string',
      'Standalone-bug conversion ask_question must contain question text');
    assert(question.question.trim(), 'Standalone-bug conversion ask_question text must not be empty');
    assert(Array.isArray(question.options) && question.options.length === 2,
      'Standalone-bug conversion ask_question must provide exactly two options');
    for (const option of question.options) {
      assert.deepStrictEqual(Object.keys(option).sort(), ['description', 'name'],
        'Each Standalone-bug conversion option must contain exactly name and description');
      assert.strictEqual(typeof option.name, 'string');
      assert(option.name.trim(), 'Standalone-bug conversion option name must not be empty');
      assert.strictEqual(typeof option.description, 'string');
      assert(option.description.trim(), 'Standalone-bug conversion option description must not be empty');
    }
    assert(Math.min(...convertedJobReloads.map((call) => call.eventIndex)) >
      mutations[0].resultEventIndex,
    'Standalone-bug conversion must reload the exact returned Bugs job after conversion completes');
    const firstConvertedReload = Math.min(...convertedJobReloads.map(
      (call) => call.resultEventIndex
    ));
    assert(firstConvertedReload < mutations[1].eventIndex,
      'Standalone-bug conversion must reload the converted Bugs job before voting');
    assertExplainedOptionVote(mutations[1], {
      optionCodes: targets.bugOptionCodes,
      questionCode: targets.bugQuestionCode,
      label: 'Standalone-bug conversion'
    });
    return;
  }

  if (phase === 'onboarding') {
    const findWorkCalls = semanticCalls.filter((call) =>
      semanticToolName(call) === 'find_work');
    assert(findWorkCalls.length > 0, 'Live onboarding must discover work through find_work');
    const guidanceTexts = codexMcpResultTexts(parsed?.events, 'find_work');
    assert(guidanceTexts.some((text) => text.includes(ONBOARDING_GUIDANCE_MARKER)),
      'Live onboarding find_work must serve the wizard-fresh setup guidance markdown');
    assert.deepStrictEqual(
      mutations.map(semanticToolName).sort(),
      ['add_collaborators', 'add_view', 'get_invite_link'],
      'Live onboarding must create one view, add one collaborator, and fetch one invite link'
    );
    const viewAdd = mutations.find((call) => semanticToolName(call) === 'add_view');
    exactInput(viewAdd, { name: ONBOARDING_VIEW_NAME, group_type: 'TEAM' },
      'Live onboarding view creation');
    const collaboratorAdd = mutations.find((call) =>
      semanticToolName(call) === 'add_collaborators');
    exactInput(collaboratorAdd, {
      emails: [ONBOARDING_COLLABORATOR_EMAIL],
      view: ONBOARDING_VIEW_NAME
    }, 'Live onboarding collaborator add');
    assert(viewAdd.resultEventIndex < collaboratorAdd.eventIndex,
      'Live onboarding must create the view before placing the collaborator in it');
    const inviteFetch = mutations.find((call) => semanticToolName(call) === 'get_invite_link');
    const inviteInput = inviteFetch.input;
    assert(inviteInput === undefined || inviteInput === null ||
      (typeof inviteInput === 'object' && !Array.isArray(inviteInput) &&
        Object.keys(inviteInput).length === 0),
    'Live onboarding invite link fetch must not invent arguments');
    assert(Math.min(...findWorkCalls.map((call) => call.resultEventIndex)) <
      Math.min(...mutations.map((call) => call.eventIndex)),
    'Live onboarding must receive the served guidance before performing setup');
    const inviteTexts = codexMcpResultTexts(parsed?.events, 'get_invite_link');
    assert(inviteTexts.some((text) => text.includes('/invite/')),
      'Live onboarding get_invite_link must return a shareable invite link');
    const visible = codexUserVisibleTexts(parsed?.events);
    assert(visible.some((text) => text.includes('/invite/')),
      'Live onboarding must hand the human the invite link in its user-visible reply');
    return;
  }

  assert.fail(`Unknown semantic transcript phase ${phase}`);
}
