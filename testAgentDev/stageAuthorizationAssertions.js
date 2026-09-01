import assert from 'assert';
import { assertSkillLoadedBeforeSemanticMcp } from './semanticAssertions.js';

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
const OTHER_PLANNING_STAGE =
  /\b(?:Proposed|Blocked|Reviewable|Skippable|Backlog|Requires\s+Input)\b/i;
const APPROVABLE_DESTINATION =
  /(?:\b(?:to|into)\s+(?:the\s+)?Approvable(?:\s+stage)?\b|\bor\b[^?!.]{0,48}\bApprovable\b)/i;
const STAGE_ACTION = '(?:move|change|set|advance|transition)';
const STAGE_ACTION_FORM = '(?:move|moved|moving|change|changed|changing|set|setting|' +
  'advance|advanced|advancing|transition|transitioned|transitioning)';
const ALTERNATE_AFTER_DOABLE = new RegExp(
  '\\bto\\s+Doable\\b[^?!.]*(?:\\bor\\b|' +
    '\\b(?:instead|alternatively|versus|elsewhere)\\b|' +
    '\\b(?:other|another|different)\\s+(?:stage|destination)\\b|' +
    `\\b${STAGE_ACTION_FORM}\\b)`,
  'i'
);
const RATIONALE_WORD = /\b(?:why|how|when|where|what|who)\b/i;

function isUclusionMcp(call) {
  const name = String(call?.name || '').toLowerCase();
  return name.startsWith('mcp__uclusion__') || name.startsWith('uclusion.');
}

function workflowToolName(call) {
  const name = String(call?.name || '').toLowerCase();
  if (name.startsWith('mcp__uclusion__')) {
    return name.slice('mcp__uclusion__'.length);
  }
  if (name.startsWith('uclusion.')) {
    return name.slice('uclusion.'.length);
  }
  return null;
}

function isRecoveredPermissionOptionLookup(
  call,
  calls,
  jobCode,
  questionCode
) {
  if (call.success !== false ||
      call.malformed ||
      workflowToolName(call) !== 'approve_job_or_option' ||
      call.input?.parent_question_short_code_id !== questionCode ||
      !/^O-/.test(call.input?.job_or_option_id || '') ||
      typeof call.id !== 'string' || !call.id ||
      !Number.isSafeInteger(call.eventIndex) ||
      !Number.isSafeInteger(call.resultEventIndex) ||
      call.eventIndex >= call.resultEventIndex) {
    return false;
  }
  const questionCall = calls.find((candidate) =>
    candidate.success === true &&
    workflowToolName(candidate) === 'ask_question' &&
    candidate.input?.job_id === jobCode &&
    candidate.resultEventIndex < call.eventIndex
  );
  if (!questionCall) {
    return false;
  }
  return calls.some((reload) =>
    reload.success === true &&
    workflowToolName(reload) === 'get_job' &&
    reload.input?.short_code_id === questionCode &&
    call.resultEventIndex < reload.eventIndex &&
    calls.some((candidate) =>
      candidate.success === true &&
      workflowToolName(candidate) === 'approve_job_or_option' &&
      candidate.input?.parent_question_short_code_id === questionCode &&
      /^O-/.test(candidate.input?.job_or_option_id || '') &&
      reload.resultEventIndex < candidate.eventIndex
    )
  );
}

function exactTargetReloads(calls, jobCode, label) {
  const reloads = calls.filter((call) => workflowToolName(call) === 'get_job' &&
    call.input?.short_code_id === jobCode);
  assert(reloads.length > 0, `${label} must load exact ${jobCode}`);
  return reloads;
}

function assertLoadedBeforeMutation(reloads, mutation, label) {
  assert(reloads.some((call) => call.resultEventIndex < mutation.eventIndex),
    `${label} must finish loading the exact job before its first mutation`);
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function permissionText(value, jobCode, jobInvestibleId) {
  const canonicalized = value.replace(
    /<a\b([^>]*)>(.*?)<\/a>/gi,
    (match, attributes, linkText) => {
      const href = attributes.match(/\bhref=(['"])(.*?)\1/i)?.[2];
      const exactJobLink = jobInvestibleId &&
        href?.split(/[?#]/, 1)[0].endsWith(`/${jobInvestibleId}`);
      if (exactJobLink) {
        return jobCode;
      }
      return jobInvestibleId && href?.includes('/dialog/')
        ? 'J-other-target'
        : linkText;
    }
  );
  return canonicalized.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function assertStagePermissionQuestion(
  value,
  jobCode,
  label,
  jobInvestibleId
) {
  assert.strictEqual(typeof value, 'string',
    `${label} must include a durable permission question`);
  const text = permissionText(value, jobCode, jobInvestibleId);
  const escapedJobCode = regexEscape(jobCode);
  const jobToken = `${escapedJobCode}(?![A-Za-z0-9-])`;
  const exactJob = new RegExp(`(?:^|[^A-Za-z0-9-])${jobToken}`, 'i');
  assert(exactJob.test(text), `${label} must name exact ${jobCode}`);
  const namedJobs = text.match(/\bJ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/gi) || [];
  assert(namedJobs.every((namedJob) =>
    namedJob.toLowerCase() === jobCode.toLowerCase()),
  `${label} must not name another job`);
  assert.match(text, /\bDoable\b/i, `${label} must name Doable`);
  const withoutAllowedSource = text.replace(
    /\bfrom\s+(?:the\s+)?Approvable(?:\s+stage)?\b/gi,
    ''
  );
  assert(!OTHER_PLANNING_STAGE.test(withoutAllowedSource),
    `${label} must not name another destination stage`);
  assert(!APPROVABLE_DESTINATION.test(text),
    `${label} must not offer Approvable as an alternate destination`);
  assert(!ALTERNATE_AFTER_DOABLE.test(text),
    `${label} must not offer an alternate after the Doable destination`);
  assert(!RATIONALE_WORD.test(text),
    `${label} must request authorization rather than rationale`);
  const sentences = text
    .split(/[?!.](?:\s+|$)/)
    .map((sentence) => sentence.replace(/^[\s*>#-]+/, '').trim())
    .filter(Boolean);
  const permissionAction = '(?:' +
    `(?:may|can|could|shall|should)\\s+(?:i|we)\\s+${STAGE_ACTION}|` +
    `(?:do|will|would)\\s+you\\s+(?:explicitly\\s+)?` +
      `(?:authorize|approve|permit|allow)\\s+` +
      `(?:(?:me|us)\\s+to\\s+)?(?:${STAGE_ACTION_FORM}|the\\s+(?:move|change|transition))|` +
    `(?:do\\s+you\\s+want|would\\s+you\\s+like)\\s+(?:me|us)\\s+to\\s+${STAGE_ACTION}|` +
    `(?:is|would)\\s+it\\s+(?:be\\s+)?(?:okay|ok|acceptable)\\s+` +
      `(?:for\\s+(?:me|us)\\s+)?to\\s+${STAGE_ACTION}|` +
    `(?:is|would)\\s+it\\s+(?:be\\s+)?(?:okay|ok|acceptable)\\s+if\\s+` +
      `(?:i|we)\\s+${STAGE_ACTION}|` +
    `do\\s+i\\s+have\\s+(?:your\\s+)?permission\\s+to\\s+${STAGE_ACTION}|` +
    `do\\s+you\\s+(?:give|grant)\\s+(?:me|us)\\s+permission\\s+to\\s+${STAGE_ACTION}|` +
    `please\\s+(?:explicitly\\s+)?(?:authorize|approve|permit|allow)\\s+` +
      `(?:(?:me|us)\\s+to\\s+)?${STAGE_ACTION_FORM}` +
  ')';
  const approvableSource =
    '(?:\\s+from\\s+(?:the\\s+)?Approvable(?:\\s+stage)?)?';
  const exactTransition = `(?:^|[^A-Za-z0-9-])${jobToken}` +
    `(?:['’]s)?(?:\\s+stage)?${approvableSource}\\s+to\\s+Doable\\b`;
  const passiveAction = '(?:moved|changed|set|advanced|transitioned)';
  const directSubjectPermission = '(?:' +
    `(?:may|can|could|shall|should)\\s+${jobToken}\\s+be\\s+${passiveAction}|` +
    `(?:do|will|would)\\s+you\\s+(?:explicitly\\s+)?` +
      `(?:authorize|approve|permit|allow)\\s+${jobToken}\\s+to\\s+` +
      `(?:be\\s+)?${STAGE_ACTION_FORM}|` +
    `(?:do\\s+you\\s+want|would\\s+you\\s+like)\\s+${jobToken}\\s+` +
      `(?:(?:to\\s+be\\s+)?${passiveAction}|to\\s+${STAGE_ACTION})` +
    `)${approvableSource}\\s+to\\s+Doable\\b`;
  const permissionLead = '(?:please\\s+confirm(?:\\s+whether|:\\s*)?\\s*)?';
  const patterns = [
    new RegExp(`^${permissionLead}${permissionAction}.{0,160}${exactTransition}`, 'i'),
    new RegExp(`^${permissionLead}${directSubjectPermission}`, 'i')
  ];
  assert(sentences.some((sentence) => patterns.some((pattern) => pattern.test(sentence))),
    `${label} must directly ask permission for ${jobCode} to move to Doable`);
}

export function assertStageAuthorizationTranscript({
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
  const targetJobCode = phase === 'stage-authorization-negative'
    ? targets.negativeJobCode
    : phase === 'stage-authorization-positive'
      ? targets.positiveJobCode
      : null;
  assert(targetJobCode, `Unknown stage-authorization transcript phase ${phase}`);
  const failedCalls = calls.filter((call) => call.success !== true);
  const recoveredLookups = phase === 'stage-authorization-negative'
    ? failedCalls.filter((call) => isRecoveredPermissionOptionLookup(
      call,
      calls,
      targets.negativeJobCode,
      targets.negativePermissionQuestionCode
    ))
    : [];
  assert(recoveredLookups.length <= 1,
    'Stage-authorization transcript may recover from only one option lookup');
  assert.deepStrictEqual(
    failedCalls.filter((call) => !recoveredLookups.includes(call)),
    [],
    'Stage-authorization transcript contains an unrecovered failed or incomplete ' +
      'Uclusion call'
  );
  const successfulCalls = calls.filter((call) => call.success === true);
  const auditCalls = successfulCalls.filter((call) =>
    WORKFLOW_AUDIT_TOOLS.has(workflowToolName(call)));
  for (const call of auditCalls) {
    assert.strictEqual(call.input?.job_id, targetJobCode,
      `${workflowToolName(call)} must remain bound to the phase's exact job`);
  }
  const workflowCalls = successfulCalls.filter((call) =>
    !WORKFLOW_AUDIT_TOOLS.has(workflowToolName(call)));
  const mutations = workflowCalls.filter((call) =>
    !READ_ONLY_WORKFLOW_TOOLS.has(workflowToolName(call)));

  if (phase === 'stage-authorization-negative') {
    const reloads = exactTargetReloads(
      workflowCalls,
      targets.negativeJobCode,
      'General work language phase'
    );
    const mutationNames = mutations.map(workflowToolName);
    assert(
      mutationNames.length >= 1 && mutationNames.length <= 2 &&
        mutationNames[0] === 'ask_question' &&
        (mutationNames.length === 1 || mutationNames[1] === 'approve_job_or_option'),
      'General work language may only ask exact stage permission and optionally vote ' +
        'on that question'
    );
    const [questionCall, optionApproval] = mutations;
    assertLoadedBeforeMutation(reloads, questionCall, 'General work language phase');
    assert.strictEqual(questionCall.input?.job_id, targets.negativeJobCode,
      'General work language must ask on the exact Approvable job');
    assertStagePermissionQuestion(
      questionCall.input?.question,
      targets.negativeJobCode,
      'General work language permission question'
    );
    const options = questionCall.input?.options;
    if (options !== undefined) {
      assert(Array.isArray(options) && options.length === 2,
        'Stage-permission options must contain one affirmative and one negative answer');
      const optionText = options.map((option) =>
        `${option?.name || ''} ${option?.description || ''}`);
      const escapedJob = regexEscape(targets.negativeJobCode);
      const exactJob = new RegExp(`(?:^|[^A-Za-z0-9-])${escapedJob}(?![A-Za-z0-9-])`, 'i');
      const optionJobToken = `${escapedJob}(?![A-Za-z0-9-])`;
      const affirmativeName = new RegExp(
        `^(?:move|change|set|advance|transition)\\s+${optionJobToken}` +
          `(?:['’]s\\s+stage)?\\s+to\\s+Doable(?:\\s+stage)?[.!]?$`,
        'i'
      );
      const keepName = new RegExp(
        `^(?:keep|leave)\\s+${optionJobToken}(?:['’]s\\s+stage)?\\s+` +
          `(?:in\\s+)?Approvable(?:\\s+stage)?[.!]?$`,
        'i'
      );
      const semantics = optionText.map((text, index) => {
        const name = String(options[index]?.name || '').trim();
        const description = String(options[index]?.description || '').trim();
        assert(name && description,
          `Stage-permission option ${index + 1} must have a concrete name and description`);
        const namedJobs = text.match(/\bJ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/gi) || [];
        assert(exactJob.test(text) && namedJobs.every((namedJob) =>
          namedJob.toLowerCase() === targets.negativeJobCode.toLowerCase()),
        `Stage-permission option ${index + 1} must name only the exact job`);
        assert(!OTHER_PLANNING_STAGE.test(text) && !APPROVABLE_DESTINATION.test(text) &&
          !/\b(?:other|another|different)\s+(?:stage|destination)\b/i.test(text) &&
          !/\belsewhere\b/i.test(text),
        `Stage-permission option ${index + 1} must not name another destination`);
        const affirmative = affirmativeName.test(name);
        const keepGated = keepName.test(name);
        assert(affirmative !== keepGated,
          `Stage-permission option ${index + 1} must be one unambiguous answer`);
        return { affirmative, keepGated };
      });
      assert.strictEqual(semantics.filter((answer) => answer.affirmative).length, 1,
        'Stage-permission options must include exactly one exact Doable authorization');
      assert.strictEqual(semantics.filter((answer) => answer.keepGated).length, 1,
        'Stage-permission options must include exactly one answer that keeps the gate');
    }
    if (optionApproval) {
      assert(Array.isArray(options),
        'An option approval requires a stage-permission question with options');
      assert(questionCall.resultEventIndex < optionApproval.eventIndex,
        'The stage-permission question must exist before its optional AI vote');
      assert.strictEqual(
        optionApproval.input?.parent_question_short_code_id,
        targets.negativePermissionQuestionCode,
        'Optional stage-permission vote must remain bound to the new exact question'
      );
      assert.match(optionApproval.input?.job_or_option_id || '', /^O-/,
        'Optional stage-permission vote must target an option');
    }
    return;
  }

  if (phase === 'stage-authorization-positive') {
    const reloads = exactTargetReloads(
      workflowCalls,
      targets.positiveJobCode,
      'Explicit stage request phase'
    );
    assert.deepStrictEqual(mutations.map(workflowToolName), ['change_job_stage'],
      'Explicit stage-only request must perform exactly one workflow mutation');
    const [stageCall] = mutations;
    assertLoadedBeforeMutation(reloads, stageCall, 'Explicit stage request phase');
    assert.strictEqual(stageCall.input?.job_id, targets.positiveJobCode,
      'Explicit stage request must target the exact named job');
    assert.strictEqual(stageCall.input?.stage, 'Doable',
      'Explicit stage request must target the exact Doable destination');
    return;
  }

  assert.fail(`Unknown stage-authorization transcript phase ${phase}`);
}
