// Two identical live Codex processes race for the same auto-take work. The
// grading decides post hoc which one won the claim; neither session is told
// about the other.
const RACERS = Object.freeze(['racer-a', 'racer-b']);

export const WORK_CLAIMS_CATALOG = Object.freeze(RACERS.map((racer) =>
  Object.freeze({
    id: `work-claim-${racer}`,
    racer,
    phase: 'work-claim-race',
    description: `concurrent ${racer} must coordinate through the work claim lock`,
    client: 'codex',
    scenario: 'work-claim-race',
    codexSandbox: 'read-only',
    key: `codex-work-claims/${racer}`,
    traceName: `codex-work-claims-${racer}.jsonl`,
    // No specific work is named: the view opted into auto-take, so an idle
    // find_work leads the agent to the one contested job. The installed
    // workflow's claim step is exactly what this catalog exists to observe,
    // so the prompt must not mention claiming.
    prompt: 'There is no work named in this message. Follow the installed ' +
      'Uclusion workflow for an idle session: run find_work and continue ' +
      'from its result without asking for permission. Do not modify project ' +
      'files and do not invent work beyond what the workflow surfaces.'
  })));

export function buildWorkClaimsPlan() {
  if (WORK_CLAIMS_CATALOG.length !== 2) {
    throw new Error('Work claims catalog must contain exactly two live processes');
  }
  return WORK_CLAIMS_CATALOG.map((session) => ({ ...session }));
}
