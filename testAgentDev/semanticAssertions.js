import assert from 'assert';

export const MAX_CODEX_REPORTED_TOKENS = 500000;

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
      if (!part.trim()) {
        return null;
      }
      parts.push(part.trim());
      part = '';
      index += 1;
    } else if (/[;&|()<>\n]/.test(character)) {
      return null;
    } else if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return null;
    } else {
      part += character;
    }
  }
  if (quote !== null || escaped || !part.trim()) {
    return null;
  }
  parts.push(part.trim());
  return parts;
}

function exactSkillPathReference(value, expectedSkillPath) {
  const candidate = normalizedPath(value);
  const expected = normalizedPath(expectedSkillPath);
  return candidate === expected || candidate === CODEX_SKILL_RELATIVE_PATH;
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
    return parts.every((part) =>
      reader(part) || isStaticBannerCommand(part, expectedSkillContent)) &&
      parts.some((part) =>
        isSimpleExactSkillReadCommand(
          part,
          expectedSkillPath,
          expectedSkillContent,
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
        depth + 1
      );
  }
  return SHELL_READERS.has(executable) && tokens.slice(executableIndex + 1)
    .some((token) => exactSkillPathReference(token, expectedSkillPath));
}

function referencesExactSkillRead(read, expectedSkillPath, expectedSkillContent) {
  const name = String(read?.name || '').toLowerCase();
  if (name === 'read' || name === 'read_file') {
    return exactSkillPathReference(
      read.input?.path ?? read.input?.file_path,
      expectedSkillPath
    );
  }
  if (!['shell', 'bash', 'exec_command', 'command_execution'].includes(name)) {
    return false;
  }
  const command = read.input?.command ?? read.input?.cmd;
  return isSimpleExactSkillReadCommand(
    Array.isArray(command) ? command.join(' ') : command,
    expectedSkillPath,
    expectedSkillContent
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

export function assertSkillLoadedBeforeSemanticMcp(parsed, {
  expectedSkillPath,
  expectedSkillContent
} = {}) {
  assert(typeof expectedSkillPath === 'string' && expectedSkillPath.trim(),
    'Semantic skill proof requires the exact staged SKILL.md path');
  assert(normalizedPath(expectedSkillPath).endsWith(`/${CODEX_SKILL_RELATIVE_PATH}`),
    `Semantic skill proof path must end in ${CODEX_SKILL_RELATIVE_PATH}`);
  assert(typeof expectedSkillContent === 'string' && expectedSkillContent,
    'Semantic skill proof requires the exact full staged SKILL.md content');
  assert(typeof parsed?.skillEndSentinel === 'string' && parsed.skillEndSentinel,
    'Semantic trace parser omitted the required skill EOF sentinel');
  assert(expectedSkillContent.trimEnd().endsWith(parsed.skillEndSentinel),
    'Expected staged skill content does not end in the required skill EOF sentinel');
  const mcpCalls = (parsed?.toolCalls || []).filter(isUclusionMcp);
  assert(mcpCalls.length > 0, 'Semantic Codex trace contains no Uclusion MCP call');
  const firstMcpIndex = Math.min(...mcpCalls.map((call) => call.eventIndex));
  const sentinelIndexes = parsed?.sentinelEventIndexes || [];
  assert(sentinelIndexes.length > 0,
    `Semantic Codex trace never exposed the literal ` +
      `${parsed?.skillEndSentinel || 'skill EOF sentinel'}`);
  assert(Math.min(...sentinelIndexes) < firstMcpIndex,
    'The literal shipped Uclusion skill EOF sentinel must load before the first semantic MCP call');
  const exactReads = (parsed?.successfulReadEvidence || []).filter((read) =>
    read.eventIndex < firstMcpIndex && read.resultEventIndex < firstMcpIndex &&
    referencesExactSkillRead(read, expectedSkillPath, expectedSkillContent));
  assert(exactReads.length > 0,
    'Semantic Codex trace has no successful read of the exact staged SKILL.md path before MCP');
  const fragments = exactReads.flatMap((read) => read.fragments
    .filter((fragment) => fragment.eventIndex < firstMcpIndex)
    .map((fragment) => fragment.text));
  assert(fragmentsCoverExactContent(fragments, expectedSkillContent),
    'Successful staged SKILL.md reads did not cover its exact full content through EOF');
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
    assert.deepStrictEqual(Object.keys(question).sort(), ['job_id', 'options', 'question'],
      'Standalone-bug conversion ask_question must contain only job_id, question, and options');
    assert.strictEqual(question.job_id, targets.bugCode,
      'Standalone-bug conversion ask_question must target the exact standalone bug');
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

  assert.fail(`Unknown semantic transcript phase ${phase}`);
}
