export function buildQuestionClosurePlan() {
  return ['closure', 'incorporation'].map((phase) => ({
    id: `question-${phase}`,
    phase,
    description: phase === 'closure'
      ? 'withdrawn choices and nested explanations settle while future design stays pending'
      : 'a current capsule incorporates a still-applicable human answer',
    client: 'codex',
    scenario: `question-${phase}`,
    codexSandbox: 'workspace-write',
    key: `codex-question-closure/${phase}`,
    traceName: `codex-question-closure-${phase}.jsonl`
  }));
}

export function questionClosurePrompt(session, targets) {
  return `Continue the design discussion for ${targets[session.phase].jobCode} using ` +
    'the current human replies and the installed Uclusion workflow. Do not implement ' +
    'project changes or work on unrelated jobs.';
}
