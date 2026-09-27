export const COMPLETION_PACKAGE_CODEX_TOKEN_CEILING = 1000000;

// T-Marketing-295: the package explains what `all` does and takes any other
// reply as ordinary words, so only `all` is tested (Q-Marketing-226 O-3).
const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'completion-package-full',
    phase: 'completion-package-full',
    description: 'an agent-chat all reply performs the ordered completion package and sweep',
    target: 'full',
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
  if (!target?.reviewCode?.startsWith('R-') || !target?.completionPackage) {
    throw new Error(`${session.key} is missing its auto-opened completion review`);
  }
  return 'all\n\n' +
    `The immediately preceding agent message linked review ${target.reviewCode} and ` +
    `printed this same completion package:\n\n${target.completionPackage}\n\n` +
    `The primary human explicitly retains exact ${target.jobCode} as this session's assigned ` +
    'lane. Handle this reply using the installed Uclusion workflow. ' +
    `All implementation and approved testing for exact ${target.taskCode} are already complete ` +
    `and testable; only ${target.taskFile} belongs to that task. Preserve its prepared diff and ` +
    'every unrelated diff unchanged, and do not run tests, builds, or security work. Do not ' +
    'deploy, force-push, mutate another Uclusion item, clear unrelated notifications, or ' +
    'offer a context clear.';
}
