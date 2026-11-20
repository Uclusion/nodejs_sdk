import assert from 'assert';
import { assertFileLoadedBeforeEvent, assertSkillLoadedBeforeSemanticMcp } from './semanticAssertions.js';

function toolName(call) {
  return /^(?:mcp__uclusion__|uclusion\.)(.+)$/.exec(String(call.name || '').toLowerCase())?.[1];
}

function assertExpiryContract(body) {
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /(?:expire[^.!?]*15[\s-]+minutes?|15[\s-]+minute[^.!?]*expir)/i);
  assert.doesNotMatch(text, /\b(?:30|thirty)[\s-]+minute/i,
    'The old expiry must not remain in the current implementation contract');
  assert.match(text, /owner[^.!?]*(?:request|trigger)[^.!?]*export/i);
  assert.match(text, /(?:keep|retain|preserv)[^.!?]*last[\s-]+successful[^.!?]*fail/i);
}

function confirmedQuestion(receipt, code, included) {
  return receipt?.short_code_id === code && receipt.status === 'completed' &&
    Number.isInteger(receipt.question_version) && receipt.question_version > 0 &&
    receipt.resolved === true && receipt.delegated === false && receipt.included_in_capsule === included;
}

export function assertQuestionClosureState(phase, before, after, targets) {
  const other = phase === 'closure' ? 'incorporation' : 'closure';
  const { markdown: _beforeMarkdown, ...beforeOther } = before[other];
  const { markdown: _afterMarkdown, ...afterOther } = after[other];
  assert.deepStrictEqual(afterOther, beforeOther, 'Unrelated fixture job changed');
  const state = after[phase];
  assert.strictEqual(state.job.resolved, false, 'Design discussion must not complete the job');
  assert.deepStrictEqual(state.job.assignments, before[phase].job.assignments);
  assert.deepStrictEqual(state.tasks, before[phase].tasks, 'Future work must remain independently retained');
  assert.deepStrictEqual(state.task_capsules, [], 'No future task capsule should be invented');
  if (phase === 'closure') {
    assert.deepStrictEqual(state.capsules, before.closure.capsules,
      'Obsolete explanations must close without rewriting the current capsule');
    assert.strictEqual(state.job.stage_id, before.closure.job.stage_id,
      'The unanswered screenshot choice must retain the Requires Input lock');
    for (const code of targets.closure.closeCodes) {
      const question = state.questions.find((item) => item.code === code);
      assert(question?.resolved, `Answered or obsolete ${code} was left open`);
      assert.strictEqual(question.delegated, false, `${code} still awaits AI handling`);
      assert.strictEqual(question.included_in_capsule, false, `${code} falsely claims incorporation`);
    }
    const pending = state.questions.find((item) => item.code === targets.closure.pendingCode);
    assert.deepStrictEqual(pending,
      before.closure.questions.find((item) => item.code === pending?.code),
      'The genuinely unanswered design choice must remain untouched');
    assert.strictEqual(pending?.resolved, false);
    assert.strictEqual(state.questions.length, before.closure.questions.length,
      'Settled explanations must not produce replacement questions');
  } else {
    const question = state.questions.find((item) => item.code === targets.incorporation.questionCode);
    assert(question?.resolved && !question.delegated && question.included_in_capsule,
      'The still-applicable answer must be confirmed incorporated');
    assert.strictEqual(state.questions.length, 1, 'The settled expiry requires no replacement question');
    assert.strictEqual(state.capsules.length, 1);
    const [capsule] = state.capsules;
    assert.strictEqual(capsule.code, targets.incorporation.capsuleCode);
    assert(capsule.version > before.incorporation.capsules[0].version);
    assertExpiryContract(capsule.body);
  }
}

export function assertQuestionClosureTranscript({
  phase, parsed, targets, expectedSkillPath, expectedSkillContent, expectedSkillFiles
}) {
  assertSkillLoadedBeforeSemanticMcp(parsed, { expectedSkillPath, expectedSkillContent });
  const calls = parsed.toolCalls.filter((call) => toolName(call));
  const receiptFor = (call) => parsed.events[call.resultEventIndex]?.item.result?.structuredContent;
  const mutations = calls.filter((call) => !['get_job', 'get_notifications', 'find_work',
    'start_job_audit', 'set_job_audit_phase', 'end_job_audit',
    'set_agent_subscription', 'claim_work', 'release_work'].includes(toolName(call)));
  const allowed = phase === 'closure' ? ['resolve', 'add_info'] : ['resolve', 'add_info', 'set_design_capsule'];
  assert(mutations.length, 'The live agent must handle the supplied design evidence');
  assert(mutations.every((call) => allowed.includes(toolName(call))),
    'The live agent performed an unrelated workflow mutation');
  const design = expectedSkillFiles.uclusion['roles/design.md'];
  assertFileLoadedBeforeEvent(parsed, {
    expectedPath: design.path, expectedContent: design.content,
    expectedRelativePath: '.agents/skills/uclusion/roles/design.md',
    expectedStartSentinel: '<!-- uclusion-skill-reference:v1 -->',
    expectedEndSentinel: '<!-- /uclusion-skill-reference:v1 -->',
    beforeEventIndex: mutations[0].eventIndex, label: 'Design role'
  });
  assert(calls.some((call) => toolName(call) === 'get_job' &&
    call.input.short_code_id === targets[phase].jobCode &&
    call.resultEventIndex < mutations[0].eventIndex), 'The exact job must be read before writing');
  if (phase === 'closure') {
    const resolves = calls.filter((call) => toolName(call) === 'resolve' && call.success === true);
    for (const code of targets.closure.closeCodes) {
      assert(resolves.some((call) => {
        const input = call.input;
        const target = input.parent_question_short_code_id
          ? `${input.parent_question_short_code_id}_${input.short_code_id}` : input.short_code_id;
        return target === code && input.included_in_capsule === false &&
          confirmedQuestion(receiptFor(call), code, false) &&
          Number.isInteger(input.expected_question_version) && input.expected_question_version > 0;
      }), `Missing confirmed versioned closure without incorporation for ${code}`);
    }
  } else {
    const receipts = calls.filter((call) => toolName(call) === 'set_design_capsule' &&
      call.success === true).map((call) => ({ call, receipt: receiptFor(call) }))
      .filter(({ receipt }) => receipt?.capsule_short_code_id === targets.incorporation.capsuleCode &&
        receipt.normalized_target === targets.incorporation.jobCode &&
        ['created', 'updated', 'unchanged'].includes(receipt.status) &&
        Number.isInteger(receipt.capsule_version) && receipt.capsule_version > 0);
    assert(receipts.length, 'No confirmed publication receipt for the current capsule');
    for (const { call } of receipts) assertExpiryContract(call.input.capsule);
    const includedInPublication = receipts.some(({ receipt }) =>
      receipt.question_resolutions?.some((question) =>
        confirmedQuestion(question, targets.incorporation.questionCode, true)));
    const acknowledgements = calls.filter((call) => toolName(call) === 'resolve' &&
      call.input.short_code_id === targets.incorporation.questionCode &&
      call.input.included_in_capsule === true);
    for (const call of acknowledgements) {
      assert(receipts.some(({ call: publication }) => publication.resultEventIndex < call.eventIndex),
        'Capsule inclusion was acknowledged before publication was confirmed');
    }
    assert(includedInPublication || acknowledgements.some((call) => call.success === true &&
      confirmedQuestion(receiptFor(call), targets.incorporation.questionCode, true)),
      'No confirmed incorporation acknowledgement followed the publication');
  }
}
