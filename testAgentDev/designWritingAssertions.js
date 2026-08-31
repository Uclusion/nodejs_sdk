import assert from 'assert';
import {
  assertFileLoadedBeforeEvent,
  assertSkillLoadedBeforeSemanticMcp
} from './semanticAssertions.js';

const DESIGN_SKILL_RELATIVE_PATH = '.agents/skills/uclusion-design/SKILL.md';
const DESIGN_EXAMPLES_RELATIVE_PATH =
  '.agents/skills/uclusion-design/references/examples.md';
const DESIGN_SKILL_START = '<!-- uclusion-design-skill:v1 -->';
const DESIGN_SKILL_END = '<!-- /uclusion-design-skill:v1 -->';
const DESIGN_EXAMPLES_START = '<!-- uclusion-design-reference:v1 -->';
const DESIGN_EXAMPLES_END = '<!-- /uclusion-design-reference:v1 -->';
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

function exactCodePattern(code) {
  const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'i');
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return String(value || '').replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (match, entity) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }
      if (normalized.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      }
      return named[normalized] ?? match;
    }
  );
}

function visibleText(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function capsuleBlocks(body) {
  const source = String(body || '');
  const blocks = [];
  const htmlBlocks = /<(p|li|blockquote|td|th)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(htmlBlocks)) {
    blocks.push({ raw: match[0], text: visibleText(match[0]) });
  }
  if (blocks.length) {
    return blocks;
  }
  return source.split(/\n\s*\n|\n(?=\s*(?:[-*+] |\d+[.)] ))/)
    .map((raw) => ({ raw, text: visibleText(raw) }))
    .filter((block) => block.text);
}

function includesTermGroup(text, alternatives) {
  const normalized = String(text || '').toLowerCase();
  return alternatives.some((term) => normalized.includes(term.toLowerCase()));
}

function includesAllTermGroups(text, groups) {
  return groups.every((alternatives) => includesTermGroup(text, alternatives));
}

function evidenceLinkMentions(block, codes) {
  const htmlLabels = [...block.raw.matchAll(
    /<a\b[^>]*\bhref\s*=\s*["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi
  )].map((match) => visibleText(match[1]));
  const markdownLabels = [...block.raw.matchAll(/\[([^\]]+)\]\([^)]+\)/g)]
    .map((match) => match[1]);
  return [...htmlLabels, ...markdownLabels].some((label) => {
    const namesEvidence = codes.every((code) => exactCodePattern(code).test(label));
    const words = label.match(/[A-Za-z]{4,}/g) || [];
    return namesEvidence && words.length >= 2;
  });
}

function assertChoiceClaimBlock(blocks, choice) {
  const questionPattern = exactCodePattern(choice.questionCode);
  const optionPattern = exactCodePattern(choice.optionCode);
  const matches = blocks.filter((block) =>
    questionPattern.test(block.raw) &&
    optionPattern.test(block.raw) &&
    includesAllTermGroups(block.text, choice.claimTermGroups) &&
    evidenceLinkMentions(block, [choice.questionCode, choice.optionCode]));
  assert(matches.length > 0,
    `${choice.key} choice must place exact ${choice.questionCode}/${choice.optionCode}, ` +
      'the selected behavior, and its descriptive link in one durable claim block');
  return matches[0];
}

function assertPlantedState(snapshot, targets, label) {
  assert(snapshot?.job, `${label} is missing the durable design job`);
  assert.strictEqual(snapshot.job.code, targets.jobCode,
    `${label} must retain the exact human-owned design job`);
  assert.strictEqual(snapshot.job.created_by, targets.adminId,
    `${label} design job must remain human-authored`);
  assert.deepStrictEqual(snapshot.job.assignments, [targets.adminId],
    `${label} design job must remain assigned only to its primary human`);
  assert.strictEqual(snapshot.job.stage_id, targets.doableStageId,
    `${label} design job must remain Doable`);
  assert.strictEqual(snapshot.job.resolved, false,
    `${label} design job must remain unresolved`);
  const lifecyclePositions = targets.lifecycleMarkers.map((marker) =>
    snapshot.job.description.indexOf(marker));
  assert(lifecyclePositions.every((position) => position >= 0),
    `${label} must retain every literal human-authored lifecycle anchor`);
  assert(lifecyclePositions.every((position, index) =>
    index === 0 || lifecyclePositions[index - 1] < position),
    `${label} must retain the human-authored lifecycle anchors in order`);
  assert.strictEqual(snapshot.open_question_count, 0,
    `${label} must contain no unresolved question`);
  assert.strictEqual(snapshot.choices.length, targets.choices.length,
    `${label} must retain exactly the two planted choices`);
  for (const target of targets.choices) {
    const choice = snapshot.choices.find((candidate) => candidate.key === target.key);
    assert(choice, `${label} is missing the ${target.key} choice`);
    assert.strictEqual(choice.question_code, target.questionCode,
      `${label} changed the ${target.key} question code`);
    assert.strictEqual(choice.option_code, target.optionCode,
      `${label} changed the ${target.key} selected option code`);
    assert.strictEqual(choice.resolved, true,
      `${label} must retain resolved ${target.questionCode}`);
    assert.strictEqual(choice.selected_by_primary, true,
      `${label} must retain the primary human's For vote on ${target.optionCode}`);
  }
}

export function assertDesignWritingState({ before, after, targets, fixtureOnly = false }) {
  assertPlantedState(before, targets, 'Design-writing fixture');
  assert.strictEqual(before.capsules.length, 0,
    'Design-writing fixture must begin without a current capsule');
  if (fixtureOnly) {
    return;
  }

  assertPlantedState(after, targets, 'Design-writing result');
  assert.strictEqual(after.capsules.length, 1,
    'Design-writing result must contain exactly one current job capsule');
  const [capsule] = after.capsules;
  assert.match(capsule.code || '', /^R-/,
    'Design-writing result current capsule must expose its durable R-code');
  assert(typeof capsule.body === 'string' && capsule.body.trim(),
    'Design-writing result current capsule must have a nonblank body');
  assert.strictEqual(capsule.pinned, true,
    'Design-writing result current capsule must remain pinned');
  assert.strictEqual(capsule.associated_comment_id, null,
    'Design-writing result current capsule must remain job-scoped');
  assert.notStrictEqual(capsule.created_by, targets.adminId,
    'Design-writing result current capsule must remain AI-authored');
  assert(after.markdown.includes(capsule.code),
    'Design-writing get_job snapshot must render the one current capsule');

  const blocks = capsuleBlocks(capsule.body);
  assert(blocks.length > 0, 'Design-writing capsule must expose readable claim blocks');
  const capsuleText = blocks.map((block) => block.text).join(' ');
  assert(includesAllTermGroups(capsuleText, targets.actorTermGroups),
    'Design-writing capsule must preserve the planted actor, trigger, and terminal outcomes');
  const capsuleLifecyclePositions = targets.lifecycleMarkers.map((marker) =>
    visibleText(capsule.body).indexOf(marker));
  assert(capsuleLifecyclePositions.every((position) => position >= 0),
    'Design-writing capsule must retain every literal human-authored lifecycle anchor');
  assert(capsuleLifecyclePositions.every((position, index) =>
    index === 0 || capsuleLifecyclePositions[index - 1] < position),
    'Design-writing capsule must retain actor trigger, terminal success, and terminal failure in order');
  const storyBlocks = [
    {
      marker: targets.lifecycleMarkers[0],
      termGroups: [['workspace owner'], ['request'], ['usage export', 'export']],
      outcome: 'actor trigger'
    },
    {
      marker: targets.lifecycleMarkers[1],
      termGroups: [['owner'], ['usage export', 'export'], ['ready', 'success', 'complete']],
      outcome: 'terminal success'
    },
    {
      marker: targets.lifecycleMarkers[2],
      termGroups: [['owner'], ['usage export', 'export'], ['fail']],
      outcome: 'terminal failure'
    }
  ];
  for (const story of storyBlocks) {
    assert(blocks.some((block) => block.raw.includes(story.marker) &&
      includesAllTermGroups(block.text, story.termGroups)),
    `Design-writing capsule must preserve the ${story.outcome} story block`);
  }

  targets.choices.forEach((choice) => assertChoiceClaimBlock(blocks, choice));
}

function stagedFile(expectedSkillFiles, packageName, relativePath) {
  const file = expectedSkillFiles?.[packageName]?.[relativePath];
  assert(file,
    `Design-writing fixture did not stage ${packageName}/${relativePath}`);
  return file;
}

function assertGetJobBeforeWrite(calls, jobCode, firstWrite) {
  const loads = calls.filter((call) => workflowToolName(call) === 'get_job' &&
    call.input?.short_code_id === jobCode);
  assert(loads.length > 0,
    `Design-writing process must load exact ${jobCode} before writing its capsule`);
  assert(loads.some((call) => call.resultEventIndex < firstWrite.eventIndex),
    `Design-writing process must finish loading exact ${jobCode} before its first capsule write`);
}

export function assertDesignWritingTranscript({
  phase,
  parsed,
  targets,
  expectedSkillPath,
  expectedSkillContent,
  expectedSkillFiles
}) {
  assert.strictEqual(phase, 'design-writing',
    `Unknown design-writing transcript phase ${phase}`);
  assertSkillLoadedBeforeSemanticMcp(parsed, {
    expectedSkillPath,
    expectedSkillContent
  });
  const calls = (parsed?.toolCalls || []).filter(isUclusionMcp);
  assert.deepStrictEqual(calls.filter((call) => call.success !== true), [],
    'Design-writing transcript contains a failed or incomplete Uclusion call');
  const semanticCalls = calls.filter((call) =>
    !WORKFLOW_AUDIT_TOOLS.has(workflowToolName(call)));
  const writes = semanticCalls.filter((call) =>
    workflowToolName(call) === 'set_design_capsule');
  assert(writes.length > 0,
    'Design-writing process must create the current intent/design capsule');
  assert.deepStrictEqual(semanticCalls.filter((call) =>
    !READ_ONLY_WORKFLOW_TOOLS.has(workflowToolName(call)) &&
    workflowToolName(call) !== 'set_design_capsule'), [],
    'Design-writing process may not mutate anything except the current capsule');

  const firstWrite = writes[0];
  const designSkill = stagedFile(expectedSkillFiles, 'uclusion-design', 'SKILL.md');
  assertFileLoadedBeforeEvent(parsed, {
    expectedPath: designSkill.path,
    expectedContent: designSkill.content,
    expectedRelativePath: DESIGN_SKILL_RELATIVE_PATH,
    expectedStartSentinel: DESIGN_SKILL_START,
    expectedEndSentinel: DESIGN_SKILL_END,
    beforeEventIndex: firstWrite.eventIndex,
    label: 'Design-writing sibling skill'
  });
  const examples = stagedFile(
    expectedSkillFiles,
    'uclusion-design',
    'references/examples.md'
  );
  assertFileLoadedBeforeEvent(parsed, {
    expectedPath: examples.path,
    expectedContent: examples.content,
    expectedRelativePath: DESIGN_EXAMPLES_RELATIVE_PATH,
    expectedStartSentinel: DESIGN_EXAMPLES_START,
    expectedEndSentinel: DESIGN_EXAMPLES_END,
    beforeEventIndex: firstWrite.eventIndex,
    label: 'Design-writing examples reference'
  });
  assertGetJobBeforeWrite(semanticCalls, targets.jobCode, firstWrite);
}
