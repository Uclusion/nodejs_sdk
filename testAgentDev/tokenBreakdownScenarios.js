// J-all-492: one live session per client does a small piece of real Uclusion
// work with the token audit on. Grading reads the job's audit note and the
// session's own saved log, never the event stream, so the Codex session can
// run through the ordinary native `codex` interface in a pseudo-terminal.
const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'token-breakdown-claude',
    client: 'claude',
    description: 'a Claude Code session with the audit on publishes its Uclusion lines'
  }),
  Object.freeze({
    id: 'token-breakdown-codex',
    client: 'codex',
    description: 'a native Codex session with the audit on publishes its Uclusion lines'
  })
]);

export const TOKEN_BREAKDOWN_CATALOG = Object.freeze(DEFINITIONS.map((definition) =>
  Object.freeze({
    ...definition,
    phase: definition.id,
    scenario: definition.id,
    key: `${definition.client}-token-breakdown`,
    traceName: `${definition.client}-token-breakdown.log`
  })));

// The labels the backend renders for each breakdown line, in order.
export const TOKEN_BREAKDOWN_LINE_LABELS = Object.freeze([
  'Skill and reference reads',
  'Bootstrap block',
  'MCP tool definitions',
  'Poke events',
  'Export command',
  'Export searches',
  'Workflow steps',
  'Repeat reads',
  'Uclusion-only turns',
  'MCP framing'
]);

export function buildTokenBreakdownPlan() {
  return TOKEN_BREAKDOWN_CATALOG.map((session) => ({ ...session }));
}

export function tokenBreakdownPrompt(session, jobCode) {
  if (typeof jobCode !== 'string' || !jobCode.trim()) {
    throw new Error(`${session.key} is missing its job code`);
  }
  // The steps are explicit so the run measures a known, small amount of
  // Uclusion work rather than grading workflow judgment.
  return `Using the installed Uclusion workflow, take up ${jobCode.trim()}. Start a ` +
    'token audit for it, read it, and add one progress note to it with add_info ' +
    'that says the probe is done. Then end the audit with handoff_type progress ' +
    'and stop. Do not change the job\'s stage, do not ask questions, do not call ' +
    'find_work, and do not modify any files.';
}
