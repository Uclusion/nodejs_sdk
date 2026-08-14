const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'authority-advisory',
    phase: 'advisory-stop',
    description: 'advisory human input must not answer or unlock the AI question',
    preparation: 'advisory-ready',
    target: 'advisoryEvent',
    assertion: 'authority-waits'
  }),
  Object.freeze({
    id: 'authority-primary-answer',
    phase: 'primary-resume',
    description: 'primary human input lets the AI resolve and continue the harmless task',
    preparation: 'primary-answer-ready',
    target: 'primaryEvent',
    assertion: 'authority-continues'
  }),
  Object.freeze({
    id: 'standalone-bug-conversion',
    phase: 'bug-conversion',
    description: 'a standalone bug becomes a human-owned Bugs job, AI question, and AI vote',
    preparation: 'standalone-bug-ready',
    target: 'bugStartEvent',
    assertion: 'bug-converted'
  })
]);

export const SEMANTIC_CATALOG = Object.freeze(DEFINITIONS.map((definition) =>
  Object.freeze({
    ...definition,
    client: 'codex',
    scenario: definition.id,
    codexSandbox: 'read-only',
    key: `codex-semantic/${definition.id}`,
    traceName: `codex-semantic-${definition.id}.jsonl`,
    prompt: `{{${definition.target}}}\n\n` +
      'Handle this exact event using the installed Uclusion workflow. ' +
      'Do not modify project files and do not work on any unrelated item.'
  })));

export const STANDALONE_BUG_CONVERSION_CATALOG = Object.freeze(
  SEMANTIC_CATALOG.filter((session) => session.phase === 'bug-conversion')
);

export function buildSemanticPlan() {
  return SEMANTIC_CATALOG.map((session) => ({ ...session }));
}

export function buildStandaloneBugConversionPlan() {
  if (STANDALONE_BUG_CONVERSION_CATALOG.length !== 1) {
    throw new Error(
      'Standalone-bug conversion catalog must contain exactly one live process'
    );
  }
  return STANDALONE_BUG_CONVERSION_CATALOG.map((session) => ({ ...session }));
}

export function semanticPrompt(session, targets) {
  const target = targets?.[session.target];
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error(`${session.key} is missing exact target ${session.target}`);
  }
  const exactEvent = target.trim();
  if (/\r|\n/.test(exactEvent)) {
    throw new Error(`${session.key} exact event must be one line`);
  }
  const inspectionCode = session.phase === 'bug-conversion'
    ? targets?.bugCode
    : targets?.questionCode;
  if (typeof inspectionCode !== 'string' || !inspectionCode.trim()) {
    throw new Error(`${session.key} is missing its exact inspection short code`);
  }
  return session.prompt.replace(`{{${session.target}}}`, exactEvent) +
    ` First load exact ${inspectionCode.trim()} for durable context.`;
}
