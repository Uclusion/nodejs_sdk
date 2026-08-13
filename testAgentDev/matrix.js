export const CLIENTS = Object.freeze(['claude', 'codex', 'cursor']);

export const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'session-start',
    description: 'session-start delivery arming',
    prompt: 'Read probe.json and report only its top-level JSON field names. Do not modify files. ' +
      'This request remains active through your final answer; do not perform idle or ' +
      'completion-time work discovery afterward.'
  }),
  Object.freeze({
    id: 'idle-find-work',
    description: 'idle greeting invokes the skill and find_work',
    prompt: 'Hello.'
  }),
  Object.freeze({
    id: 'first-poke',
    description: 'unrelated request receives its first real dev Poke',
    prompt: 'Read probe.json and report only its top-level JSON field names. Do not modify files. ' +
      'This request remains active through your final answer; after handling any live Poke, ' +
      'return directly to this request and do not perform completion-time work discovery.'
  })
]);

export function buildSessionMatrix() {
  return CLIENTS.flatMap((client) => SCENARIOS.map((scenario) => ({
    client,
    scenario: scenario.id,
    description: scenario.description,
    prompt: scenario.prompt,
    key: `${client}/${scenario.id}`,
    traceName: `${client}-${scenario.id}.jsonl`
  })));
}
