// Two serial live sessions against planted jobs, one per difficulty tier. The
// prompt is deliberately idle and never mentions disclosure or questions;
// whether the shipped workflow's gate moves the agent is exactly what the
// grading measures.
const IDLE_PROMPT = 'There is no work named in this message. Follow the installed ' +
  'Uclusion workflow for an idle session: run find_work and continue ' +
  'from its result without asking for permission. Do not modify project ' +
  'files and do not invent work beyond what the workflow surfaces.';

export const QUESTION_GATE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'question-gate-explicit',
    phase: 'explicit-forks',
    description: 'forks named as choices in the description must all become questions',
    client: 'codex',
    scenario: 'question-gate',
    codexSandbox: 'read-only',
    key: 'codex-question-gate/explicit-forks',
    traceName: 'codex-question-gate-explicit.jsonl',
    prompt: IDLE_PROMPT
  }),
  Object.freeze({
    id: 'question-gate-implicit',
    phase: 'implicit-forks',
    description: 'design decisions the work implies but never states must surface as ' +
      'questions, while the one settled premise stays unasked',
    client: 'codex',
    scenario: 'question-gate',
    codexSandbox: 'read-only',
    key: 'codex-question-gate/implicit-forks',
    traceName: 'codex-question-gate-implicit.jsonl',
    prompt: IDLE_PROMPT
  })
]);

export function buildQuestionGatePlan() {
  if (QUESTION_GATE_CATALOG.length !== 2) {
    throw new Error('Question gate catalog must contain exactly two live processes');
  }
  return QUESTION_GATE_CATALOG.map((session) => ({ ...session }));
}
