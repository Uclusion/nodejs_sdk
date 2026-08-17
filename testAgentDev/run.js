#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { executeHarness } from './harness.js';
import { buildSessionMatrix } from './matrix.js';
import {
  buildSemanticPlan,
  buildStandaloneBugConversionPlan
} from './semanticScenarios.js';
import { buildOnboardingPlan } from './onboardingScenarios.js';
import { buildWorkClaimsPlan } from './workClaimsScenarios.js';
import { buildQuestionGatePlan } from './questionGateScenarios.js';

const SEMANTIC_PLAN_BUILDERS = Object.freeze({
  semantic: buildSemanticPlan,
  'semantic-standalone-bug-conversion': buildStandaloneBugConversionPlan,
  onboarding: buildOnboardingPlan
});
const WORK_CLAIMS_CATALOG = 'work-claims';
const QUESTION_GATE_CATALOG = 'question-gate';

function selectedCatalog(argv) {
  const index = argv.indexOf('--catalog');
  const catalog = index === -1 ? 'triggers' : argv[index + 1];
  if (catalog !== 'triggers' && catalog !== WORK_CLAIMS_CATALOG &&
      catalog !== QUESTION_GATE_CATALOG &&
      !Object.hasOwn(SEMANTIC_PLAN_BUILDERS, catalog)) {
    throw new Error(`Unknown agent dev catalog ${catalog || '(missing)'}`);
  }
  return catalog;
}

const directory = path.dirname(fileURLToPath(import.meta.url));
const catalog = selectedCatalog(process.argv.slice(2));
const semanticCatalog = Object.hasOwn(SEMANTIC_PLAN_BUILDERS, catalog);
const workClaimsCatalog = catalog === WORK_CLAIMS_CATALOG;
const questionGateCatalog = catalog === QUESTION_GATE_CATALOG;
const defaultArtifactDir = semanticCatalog || workClaimsCatalog || questionGateCatalog
  ? path.join(directory, 'artifacts', catalog)
  : path.join(directory, 'artifacts');
const artifactDir = path.resolve(
  process.env.TEST_AGENT_DEV_ARTIFACT_DIR || defaultArtifactDir
);
const webUiRoot = process.env.TEST_AGENT_DEV_WEB_UI_ROOT ||
  path.join(directory, '__missing_TEST_AGENT_DEV_WEB_UI_ROOT__');
if (!process.env.TEST_AGENT_DEV_WEB_UI_ROOT) {
  process.stderr.write(
    'TEST_AGENT_DEV_WEB_UI_ROOT is required and must point to the uclusion_web_ui checkout.\n'
  );
}
const options = {
  artifactDir,
  seedPinsPath: path.join(directory, 'last-known-good.json'),
  webUiRoot: path.resolve(webUiRoot)
};
let plan = semanticCatalog
  ? SEMANTIC_PLAN_BUILDERS[catalog]()
  : workClaimsCatalog
    ? buildWorkClaimsPlan()
    : questionGateCatalog
      ? buildQuestionGatePlan()
      : buildSessionMatrix();
// --phase <name> narrows a multi-tier catalog to one phase so a fixed tier
// can re-verify without re-paying for tiers that already passed.
const phaseIndex = process.argv.indexOf('--phase');
if (phaseIndex !== -1) {
  const phase = process.argv[phaseIndex + 1];
  const narrowed = plan.filter((session) => session.phase === phase);
  if (!narrowed.length) {
    throw new Error(`No ${catalog} session has phase ${phase || '(missing)'}`);
  }
  plan = narrowed;
}
if (semanticCatalog || workClaimsCatalog || questionGateCatalog) {
  options.catalog = catalog;
  options.sessions = plan;
  options.reportProgress = (message) => process.stdout.write(`${message}\n`);
  if (catalog === 'onboarding') {
    const { OnboardingDevFixture } = await import('./onboardingFixture.js');
    options.dependencies = {
      createFixture: (fixtureOptions) => new OnboardingDevFixture(fixtureOptions)
    };
  }
}
const result = semanticCatalog
  ? await (await import('./semanticHarness.js')).executeSemanticHarness(options)
  : workClaimsCatalog
    ? await (await import('./workClaimsHarness.js')).executeWorkClaimsHarness(options)
    : questionGateCatalog
      ? await (await import('./questionGateHarness.js')).executeQuestionGateHarness(options)
      : await executeHarness(options);
const passed = result.results.filter((entry) => entry.status === 'passed').length;
const summary = semanticCatalog || workClaimsCatalog || questionGateCatalog
  ? `Agent dev ${catalog} catalog ${result.status}: ` +
    `${passed}/${plan.length} live phases passed. Artifacts: ${artifactDir}\n`
  : `Agent dev gate ${result.status}: ${passed}/9 sessions passed. ` +
    `Artifacts: ${artifactDir}\n`;
process.stdout.write(summary);
if (result.status !== 'passed') {
  process.exitCode = 1;
}
