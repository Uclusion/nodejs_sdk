export function buildDesignHandoffPlan() {
  return [{
    id: 'design-handoff', phase: 'design-handoff', client: 'codex',
    scenario: 'independent-design-stage-implementation',
    key: 'codex-design-handoff/continuing-session',
    traceName: 'codex-design-handoff.jsonl',
    description: 'independent scope handoffs and retained implementation owners across a stage change'
  }];
}

export function designHandoffPrompts(jobCode, taskCode) {
  return [
    `Start ${jobCode}`,
    `Continue ${jobCode}.`,
    `For ${taskCode}, change the card sentence to “Cedar grows steadily.” ` +
      'Keep the same filename and one trailing newline.'
  ];
}
