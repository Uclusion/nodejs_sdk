import { DEV_ADVISORY_IDENTITY } from './devIdentities.js';

export const ONBOARDING_VIEW_NAME = 'Engineering';
export const ONBOARDING_COLLABORATOR_EMAIL = DEV_ADVISORY_IDENTITY.username;

export const ONBOARDING_CATALOG = Object.freeze([
  Object.freeze({
    id: 'onboarding-setup',
    phase: 'onboarding',
    description: 'wizard-fresh workspace guidance leads to a view, a collaborator, and an invite link',
    client: 'codex',
    scenario: 'onboarding-setup',
    codexSandbox: 'read-only',
    key: 'codex-onboarding/onboarding-setup',
    traceName: 'codex-onboarding-onboarding-setup.jsonl',
    // T-all-2472 and S-all-244: the agent must receive the served setup guidance,
    // create the requested view, add the collaborator by email into it, and hand
    // back an invite link. The prompt pre-authorizes acceptance because the live
    // process is a single turn.
    prompt: 'Hello. This workspace is brand new. If work discovery reports no work and ' +
      `offers view and collaborator setup, the answer is yes: add a TEAM view named ` +
      `${ONBOARDING_VIEW_NAME}, add ${ONBOARDING_COLLABORATOR_EMAIL} to that view as a ` +
      'collaborator, then share the invite link so more collaborators can join. Do not ' +
      'modify project files.'
  })
]);

export function buildOnboardingPlan() {
  if (ONBOARDING_CATALOG.length !== 1) {
    throw new Error('Onboarding catalog must contain exactly one live process');
  }
  return ONBOARDING_CATALOG.map((session) => ({ ...session }));
}
