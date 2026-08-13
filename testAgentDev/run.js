#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { executeHarness } from './harness.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(
  process.env.TEST_AGENT_DEV_ARTIFACT_DIR || path.join(directory, 'artifacts')
);
const webUiRoot = process.env.TEST_AGENT_DEV_WEB_UI_ROOT ||
  path.join(directory, '__missing_TEST_AGENT_DEV_WEB_UI_ROOT__');
if (!process.env.TEST_AGENT_DEV_WEB_UI_ROOT) {
  process.stderr.write(
    'TEST_AGENT_DEV_WEB_UI_ROOT is required and must point to the uclusion_web_ui checkout.\n'
  );
}
const result = await executeHarness({
  artifactDir,
  seedPinsPath: path.join(directory, 'last-known-good.json'),
  webUiRoot: path.resolve(webUiRoot)
});
const passed = result.results.filter((entry) => entry.status === 'passed').length;
process.stdout.write(
  `Agent dev gate ${result.status}: ${passed}/9 sessions passed. Artifacts: ${artifactDir}\n`
);
if (result.status !== 'passed') {
  process.exitCode = 1;
}
