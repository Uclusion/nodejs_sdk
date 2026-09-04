export const COMPLETION_PACKAGE_CODEX_TOKEN_CEILING = 1000000;

const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'completion-package-declined',
    phase: 'completion-package-declined',
    description: 'an agent-chat none reply declines every post-review completion action',
    target: 'declined',
    selection: 'none',
    selectionSource: 'agent',
    codexSandbox: 'read-only'
  }),
  Object.freeze({
    id: 'completion-package-partial',
    phase: 'completion-package-partial',
    description: 'an earlier review 1 reply defeats a later agent 1,2 reply',
    target: 'partial',
    selection: '1',
    selectionSource: 'review',
    laterAgentSelection: '1,2',
    codexSandbox: 'workspace-write',
    codexReportedTokenCeiling: COMPLETION_PACKAGE_CODEX_TOKEN_CEILING
  }),
  Object.freeze({
    id: 'completion-package-full',
    phase: 'completion-package-full',
    description: 'an agent-chat all reply performs the ordered completion package and sweep',
    target: 'full',
    selection: 'all',
    selectionSource: 'agent',
    codexSandbox: 'workspace-write',
    codexNetworkAccess: true,
    codexReportedTokenCeiling: COMPLETION_PACKAGE_CODEX_TOKEN_CEILING
  })
]);

export const COMPLETION_PACKAGE_CATALOG = Object.freeze(DEFINITIONS.map((definition) =>
  Object.freeze({
    ...definition,
    client: 'codex',
    scenario: definition.id,
    key: `codex-completion-package/${definition.target}`,
    traceName: `codex-completion-package-${definition.target}.jsonl`
  })));

export function buildCompletionPackagePlan() {
  return COMPLETION_PACKAGE_CATALOG.map((session) => ({ ...session }));
}

export function completionPackagePrompt(session, targets) {
  const target = targets?.[session.target];
  if (!target?.jobCode?.startsWith('J-') || !target?.taskCode?.startsWith('T-')) {
    throw new Error(`${session.key} is missing its exact completion-package target`);
  }
  if (!['all', 'none', '1'].includes(session.selection)) {
    throw new Error(`${session.key} is missing its exact completion selection`);
  }
  if (!['agent', 'review'].includes(session.selectionSource)) {
    throw new Error(`${session.key} is missing its exact completion response channel`);
  }
  if (!target?.reviewCode?.startsWith('R-') || !target?.completionMenu) {
    throw new Error(`${session.key} is missing its auto-opened completion review`);
  }
  if (session.selectionSource === 'review' &&
    (!target.reviewReplyCode?.startsWith('C-') || !session.laterAgentSelection)) {
    throw new Error(`${session.key} is missing its first review reply or later agent reply`);
  }
  const priorPrompt = `The immediately preceding agent message linked review ` +
    `${target.reviewCode} and printed this same menu:\n\n${target.completionMenu}`;
  const agentSelection = session.laterAgentSelection || session.selection;
  const reply = `${agentSelection}\n\nThis is my direct reply in the agent to the four numbered ` +
    `completion actions for exact ${target.jobCode}.`;
  return `${reply}\n\n${priorPrompt}\n\n` +
    `The primary human explicitly retains exact ${target.jobCode} as this session's assigned ` +
    'lane. Handle this selection using the installed Uclusion workflow. Do not create or ' +
    'resolve a Uclusion question for this completion permission, and do not open or update ' +
    'another review. ' +
    `All implementation and approved testing for exact ${target.taskCode} are already complete ` +
    `and testable; only ${target.taskFile} belongs to that task. Preserve its prepared diff and ` +
    'every unrelated diff unchanged, and do not run tests, builds, or security work. Reload ' +
    `the exact ${target.reviewCode} review thread and the exact job with assistance, then perform ` +
    'only the package actions the first valid selection ' +
    'authorizes, in their required order. Do not ask again ' +
    'for individual package actions. Do not deploy, force-push, mutate ' +
    'another Uclusion item, clear unrelated notifications, offer a context clear, or switch ' +
    'lanes before any authorized completion sweep finishes.';
}
