const DESIGN_WRITING_SESSION = Object.freeze({
  id: 'design-writing-capsule',
  phase: 'design-writing',
  description: 'resolved human choices become one evidence-linked design capsule',
  client: 'codex',
  scenario: 'design-writing-capsule',
  codexSandbox: 'read-only',
  key: 'codex-design-writing/capsule',
  traceName: 'codex-design-writing-capsule.jsonl',
  prompt: '{{startEvent}}\n\nHandle this exact Start event using the installed ' +
    'Uclusion workflow. Load exact {{jobCode}} and create its current intent/design ' +
    'capsule from the already-resolved human evidence. Do not modify project files, ' +
    'resolve the job, request review, or work on any unrelated item.'
});

export function buildDesignWritingPlan() {
  return [{ ...DESIGN_WRITING_SESSION }];
}

export function designWritingPrompt(session, targets) {
  const startEvent = targets?.startEvent;
  const jobCode = targets?.jobCode;
  if (typeof startEvent !== 'string' || !startEvent.trim() || /\r|\n/.test(startEvent)) {
    throw new Error(`${session.key} is missing its one-line Start event`);
  }
  if (typeof jobCode !== 'string' || !jobCode.trim()) {
    throw new Error(`${session.key} is missing its exact design job code`);
  }
  return session.prompt
    .replace('{{startEvent}}', startEvent.trim())
    .replace('{{jobCode}}', jobCode.trim());
}
