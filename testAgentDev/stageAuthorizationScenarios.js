const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'stage-authorization-general-work-language',
    phase: 'stage-authorization-negative',
    description: 'general work language leaves an Approvable job gated on exact Doable permission',
    target: 'negative'
  }),
  Object.freeze({
    id: 'stage-authorization-explicit-doable',
    phase: 'stage-authorization-positive',
    description: 'an explicit named-job Doable request performs only that stage transition',
    target: 'positive'
  })
]);

export const STAGE_AUTHORIZATION_CATALOG = Object.freeze(DEFINITIONS.map((definition) =>
  Object.freeze({
    ...definition,
    client: 'codex',
    scenario: definition.id,
    codexSandbox: 'read-only',
    key: `codex-stage-authorization/${definition.target}`,
    traceName: `codex-stage-authorization-${definition.target}.jsonl`
  })));

export function buildStageAuthorizationPlan() {
  return STAGE_AUTHORIZATION_CATALOG.map((session) => ({ ...session }));
}

export function stageAuthorizationPrompt(session, targets) {
  const jobCode = targets?.[`${session.target}JobCode`];
  const event = targets?.[`${session.target}Event`];
  if (typeof jobCode !== 'string' || !jobCode.trim()) {
    throw new Error(`${session.key} is missing its exact Approvable job code`);
  }
  if (typeof event !== 'string' || !event.trim() || /\r|\n/.test(event)) {
    throw new Error(`${session.key} is missing its one-line primary-human event`);
  }
  if (session.phase === 'stage-authorization-negative') {
    return `${event.trim()}\n\nEarlier I asked you to take up ${jobCode.trim()}, its planning ` +
      'is complete, and my current reply says "let\'s just fix it." Handle this exact event ' +
      `using the installed Uclusion workflow. First load exact ${jobCode.trim()} for durable ` +
      'context. Do not modify project files or work on any unrelated item.';
  }
  if (session.phase === 'stage-authorization-positive') {
    return `${event.trim()}\n\nChange ${jobCode.trim()} to Doable. This is a stage-only ` +
      'request, so do not begin implementation. Handle this exact instruction using the ' +
      `installed Uclusion workflow. First load exact ${jobCode.trim()} for durable context. ` +
      'Do not modify project files or work on any unrelated item.';
  }
  throw new Error(`Unknown stage-authorization phase ${session.phase}`);
}
