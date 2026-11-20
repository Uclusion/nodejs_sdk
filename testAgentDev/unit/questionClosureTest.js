import assert from 'assert';
import { questionClosureNativeEvents } from '../questionClosureNativeSession.js';
import { assertQuestionClosureState, assertQuestionClosureTranscript } from '../questionClosureAssertions.js';
import { parseAgentTrace } from '../trace.js';

const capsuleCode = 'R-Default-1';
const questionCode = 'Q-Default-1';
const jobCode = 'J-Default-1';
const targets = { incorporation: { capsuleCode, questionCode, jobCode } };
const skillPath = '/tmp/fixture/.agents/skills/uclusion/SKILL.md';
const designPath = '/tmp/fixture/.agents/skills/uclusion/roles/design.md';
const skill = '<!-- uclusion-skill:v1 -->\nCore workflow\n<!-- /uclusion-skill:v1 -->';
const design = '<!-- uclusion-skill-reference:v1 -->\nDesign workflow\n<!-- /uclusion-skill-reference:v1 -->';
const contract = 'When the owner requests an export, links expire after 15 minutes. ' +
  'Keep the last successful export if a later export fails.';

function nativeCall(id, start, tool, args, receipt) {
  return { id, type: 'mcpToolCall', server: 'Uclusion', tool, arguments: args,
    status: 'completed', startedAtMs: start, completedAtMs: start + 1,
    result: { content: [], structuredContent: receipt } };
}

function transcript(acknowledgementStart = 10) {
  const reads = [[skillPath, skill], [designPath, design]].map(([file, output], index) => ({
    id: `read-${index}`, type: 'commandExecution', command: `cat ${file}`,
    aggregatedOutput: output, exitCode: 0, status: 'completed',
    startedAtMs: index * 2, completedAtMs: index * 2 + 1
  }));
  const publication = nativeCall('publish', 8, 'set_design_capsule',
    { update_capsule_short_code_id: capsuleCode, update_capsule_version: 1, capsule: contract },
    { status: 'updated', normalized_target: jobCode,
      capsule_short_code_id: capsuleCode, capsule_version: 2 });
  const acknowledgement = nativeCall('acknowledge', acknowledgementStart, 'resolve',
    { short_code_id: questionCode, expected_question_version: 3, included_in_capsule: true },
    { short_code_id: questionCode, status: 'completed', question_version: 4,
      resolved: true, delegated: false, included_in_capsule: true });
  const threads = { root: { id: 'root', turns: [{ items: [
    ...reads, nativeCall('load', 4, 'get_job', { short_code_id: jobCode }, {}),
    publication, acknowledgement
  ] }] } };
  return { phase: 'incorporation', parsed: parseAgentTrace(questionClosureNativeEvents(threads), null, 'codex'),
    targets, expectedSkillPath: skillPath, expectedSkillContent: skill,
    expectedSkillFiles: { uclusion: { 'roles/design.md': { path: designPath, content: design } } } };
}

describe('question closure live regression grading', () => {
  it('requires publication to complete before separate inclusion acknowledgement', () => {
    assert.doesNotThrow(() => assertQuestionClosureTranscript(transcript()));
    assert.throws(() => assertQuestionClosureTranscript(transcript(6)),
      /before publication was confirmed/);
  });

  it('rejects a nominally successful publication without a confirmed capsule identity', () => {
    const input = transcript();
    const published = input.parsed.events.find((event) =>
      event.type === 'item.completed' && event.item.tool === 'set_design_capsule');
    published.item.result.structuredContent.status = 'unconfirmed';
    assert.throws(() => assertQuestionClosureTranscript(input), /No confirmed publication receipt/);
  });

  it('requires a confirmed inclusion receipt rather than transport success', () => {
    const input = transcript();
    const acknowledgement = input.parsed.events.find((event) =>
      event.type === 'item.completed' && event.item.tool === 'resolve');
    acknowledgement.item.result.structuredContent.status = 'unconfirmed';
    assert.throws(() => assertQuestionClosureTranscript(input), /No confirmed incorporation/);
  });

  it('does not use publication of the old contract as permission to acknowledge inclusion', () => {
    const input = transcript();
    const publication = input.parsed.toolCalls.find((call) => call.id === 'publish');
    publication.input.capsule = contract.replace('15 minutes', '30 minutes');
    assert.throws(() => assertQuestionClosureTranscript(input));
  });

  it('rejects keeping the old contract and merely appending the new requested expiry', () => {
    const base = { job: { resolved: false, assignments: [] }, tasks: [], task_capsules: [],
      questions: [{ code: questionCode, resolved: true, delegated: false, included_in_capsule: true }],
      capsules: [{ code: capsuleCode, version: 1, body: 'Original' }] };
    const before = { closure: {}, incorporation: base };
    const after = { closure: {}, incorporation: { ...base,
      capsules: [{ code: capsuleCode, version: 2,
        body: contract }] } };
    assert.doesNotThrow(() => assertQuestionClosureState('incorporation', before, after, targets));
    after.incorporation.capsules[0].body =
      'When the owner requests an export, links expire after 30 minutes. ' +
      'Keep the last successful export if a later export fails. Human requested 15 minutes.';
    assert.throws(() => assertQuestionClosureState('incorporation', before, after, targets));
  });

  it('fails closed when native history lacks completed timing evidence', () => {
    const call = nativeCall('missing-time', 0, 'get_job', { short_code_id: jobCode }, {});
    call.completedAtMs = null;
    assert.throws(() => questionClosureNativeEvents({ root: { id: 'root', turns: [{ items: [call] }] } }),
      /incomplete timing evidence/);
  });

  it('fails closed rather than omitting a retired helper whose full history is unavailable', () => {
    assert.throws(() => questionClosureNativeEvents({
      root: { id: 'root', turns: [] },
      helper: { id: 'helper', parentThreadId: 'root', historyUnavailable: 'retired', turns: [] }
    }), /Native helper history is incomplete/);
  });
});
