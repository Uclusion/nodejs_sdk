#!/usr/bin/env node
// Exploratory native acceptance probe. Workflow judgment stays outside the
// participant workspace; the mechanical harness captures the evidence.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mcpCall, mcpText, pollFor } from '../tests/commonTestFunctions.js';
import { SemanticDevFixture, pollMcp } from './semanticFixture.js';
import { executeSemanticHarness } from './semanticHarness.js';
import { runQuestionClosureNativeSession } from './questionClosureNativeSession.js';
import { assertFileLoadedBeforeEvent, assertSkillLoadedBeforeSemanticMcp } from './semanticAssertions.js';
import { deleteIntegrationTestMarket } from './devFixture.js';
import { createPendingMarketCleanup, runAfterPendingMarketCleanup } from './pendingMarketCleanup.js';

export const BUG_DESCRIPTION = '```\n' +
  'You can raise or lower the per-session concurrency limit in ~/.codex/config.toml ' +
  'under [agents] using max_concurrent_threads_per_session (which can be set up to 64 ' +
  'in recent configurations).\n```\n\n' +
  "Uclusion needs an opinionated choice on this setting. We need to come up with what we think " +
  "the number would best be for Uclusion's purposes and set the number if it is not set and " +
  'ask to override in the install if it is.\n\n' +
  '**Part of this bug has to be verifying that the MCP each subagent has does not include ' +
  'anything taking up CPU - for instance only the coordinator should have a socket for pokes.**';

export const SETTLED_CHOICE = 'Use exactly 4 concurrent spawned helpers, excluding the coordinator ' +
  '(5 total threads including the coordinator). I choose that default and authorize implementing ' +
  'it for this bug. If the installed Codex uses a total-thread setting, use the equivalent total. ' +
  'Keep the requested absent-setting behavior, existing-setting override prompt, and ' +
  'coordinator-only Poke socket requirement.';

const LOCAL_VERIFICATION_AUTHORITY = 'You may implement this bug in the supplied source checkout ' +
  'and run its relevant existing local Python tests and focused local regression tests.';
const ROOT_VERIFICATION_FILES = ['checkWorkflowAssetPins.py', 'countArtifactTokens.py'];

function git(workspace, args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `Fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export class BugCollaborationFixture extends SemanticDevFixture {
  constructor(options) {
    super(options);
    this.phase = options.env.TEST_AGENT_DEV_BUG_CHOICE_PHASE || 'unresolved';
    this.implementationSourceRoot = options.env.TEST_AGENT_DEV_IMPLEMENTATION_SOURCE_ROOT || this.webUiRoot;
    assert(['unresolved', 'settled'].includes(this.phase), 'Unknown bug collaboration phase');
    for (const name of ROOT_VERIFICATION_FILES) {
      assert(fs.statSync(path.join(this.implementationSourceRoot, name)).isFile(),
        `Implementation snapshot is missing required verification file ${name}`);
    }
  }

  async initializeScenario() {
    await mcpCall(this.primaryConfiguration, this.uclusionToken, 'add_bug', {
      bug: BUG_DESCRIPTION, severity: 'RED'
    });
    this.bug = await this.findComment("Uclusion needs an opinionated choice on this setting.");
    assert(this.bug?.ticket_code?.startsWith('B-'), 'Fixture has no standalone B-code');
    assert(!this.bug.investible_id, 'Fixture bug is already part of a job');
    await this.adminClient.investibles.createComment(undefined, this.marketId,
      LOCAL_VERIFICATION_AUTHORITY, this.bug.id);
    await pollFor(() => this.listComments(), (records) => records.some((record) =>
      record.body?.includes(LOCAL_VERIFICATION_AUTHORITY) && record.created_by === this.adminId), 20, 1000);
    if (this.phase === 'settled') {
      await this.adminClient.investibles.createComment(undefined, this.marketId,
        SETTLED_CHOICE, this.bug.id);
      await pollFor(() => this.listComments(), (records) => records.some((record) =>
        record.body?.includes(SETTLED_CHOICE) && record.created_by === this.adminId), 20, 1000);
    }
  }

  targets() { return { bugCode: this.bug.ticket_code }; }

  preparePhase(session) {
    this.local = this.createPhaseFixture(session, `Start ${this.bug.ticket_code}`);
    const scripts = path.join(this.local.workspace, 'public', 'scripts');
    fs.cpSync(path.join(this.implementationSourceRoot, 'public', 'scripts'), scripts, {
      recursive: true, filter: (name) => !name.split(path.sep).includes('__pycache__')
    });
    for (const name of ROOT_VERIFICATION_FILES) fs.copyFileSync(
      path.join(this.implementationSourceRoot, name), path.join(this.local.workspace, name));
    fs.writeFileSync(path.join(this.local.workspace, '.gitignore'),
      '.agents/\ndev_uclusion.json\nprobe.json\n__pycache__/\n*.pyc\n');
    git(this.local.workspace, ['init', '--quiet']);
    git(this.local.workspace, ['config', 'user.email', 'fixture@example.invalid']);
    git(this.local.workspace, ['config', 'user.name', 'Isolated acceptance fixture']);
    git(this.local.workspace, ['add', 'public', 'AGENTS.md', '.gitignore', ...ROOT_VERIFICATION_FILES]);
    git(this.local.workspace, ['commit', '--quiet', '-m', 'Disposable installed-release fixture']);
    return this.local;
  }

  async snapshotSemantic() {
    const [records, jobs, markdown] = await Promise.all([
      this.listComments(), this.listInvestibles(),
      pollMcp(this.primaryConfiguration, this.uclusionToken, 'get_job', {
        short_code_id: this.bug.ticket_code, include_all_resolved: true
      })
    ]);
    const bug = records.find((record) => record.id === this.bug.id);
    const decisions = [];
    for (const record of records.filter((item) => item.inline_market_id)) {
      decisions.push({ question: record, options: await this.listInvestibles(record.inline_market_id) });
    }
    const workspace = this.local?.workspace;
    const sourceChanges = workspace && fs.existsSync(workspace) ? {
      status: git(workspace, ['status', '--short']),
      diff: git(workspace, ['diff', '--binary', 'HEAD']),
      newFiles: Object.fromEntries(git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0').filter(Boolean).map((name) => [name,
          fs.readFileSync(path.join(workspace, name), 'utf8')]))
    } : null;
    return { phase: this.phase, bug, records, jobs, decisions,
      markdown: mcpText(markdown), sourceChanges };
  }

  assertPhase(_phase, before, after) {
    assert(after.bug && !after.bug.deleted, 'Participant deleted the original bug');
    assert.strictEqual(after.bug.body, before.bug.body, 'Participant rewrote the original human bug');
    for (const record of before.records.filter((item) => item.created_by === this.adminId)) {
      const current = after.records.find((item) => item.id === record.id);
      assert(current && !current.deleted && current.body === record.body,
        'Participant removed or rewrote authoritative human evidence');
    }
  }
}

export function assertBugCollaborationTrace({ parsed, targets,
  expectedSkillPath, expectedSkillContent, expectedSkillFiles }) {
  assertSkillLoadedBeforeSemanticMcp(parsed, { expectedSkillPath, expectedSkillContent });
  const rootId = parsed.events[0]?.thread_id;
  const bugRead = parsed.toolCalls.find((call) => /(?:__|\.)get_job$/.test(call.name) &&
    call.input.short_code_id === targets.bugCode && call.success &&
    parsed.events[call.eventIndex]?.item.nativeThreadId !== rootId);
  assert(bugRead, 'A real helper did not read the exact standalone bug');
  const ownerId = parsed.events[bugRead.eventIndex].item.nativeThreadId;
  const ownerReads = { ...parsed, successfulReadEvidence: parsed.successfulReadEvidence
    .filter((read) => parsed.events[read.eventIndex]?.item.nativeThreadId === ownerId) };
  const role = expectedSkillFiles.uclusion['roles/standalone.md'];
  assertFileLoadedBeforeEvent(ownerReads, {
    expectedPath: role.path, expectedContent: role.content,
    expectedRelativePath: '.agents/skills/uclusion/roles/standalone.md',
    expectedStartSentinel: '<!-- uclusion-skill-reference:v1 -->',
    expectedEndSentinel: '<!-- /uclusion-skill-reference:v1 -->',
    beforeEventIndex: bugRead.eventIndex, label: 'Standalone owner role'
  });
  const collaboration = expectedSkillFiles.uclusion['references/collaboration.md'];
  if (collaboration) assertFileLoadedBeforeEvent(ownerReads, {
    expectedPath: collaboration.path, expectedContent: collaboration.content,
    expectedRelativePath: '.agents/skills/uclusion/references/collaboration.md',
    expectedStartSentinel: '<!-- uclusion-skill-reference:v1 -->',
    expectedEndSentinel: '<!-- /uclusion-skill-reference:v1 -->',
    beforeEventIndex: bugRead.eventIndex, label: 'Shared collaboration procedure'
  });
}

async function main() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const webUiRoot = process.env.TEST_AGENT_DEV_WEB_UI_ROOT;
  const artifactDir = process.env.TEST_AGENT_DEV_ARTIFACT_DIR;
  assert(webUiRoot && artifactDir, 'Provide isolated source and artifact paths');
  const phase = process.env.TEST_AGENT_DEV_BUG_CHOICE_PHASE || 'unresolved';
  assert(['unresolved', 'settled'].includes(phase));
  const receipts = [];
  const cleanup = createPendingMarketCleanup({ artifactDir,
    deleteMarket: async (marketId) => {
      const result = await deleteIntegrationTestMarket(marketId);
      receipts.push({ market_id: marketId, deleted_at: new Date().toISOString(), result });
      fs.writeFileSync(path.join(artifactDir, 'cleanup-receipts.json'),
        `${JSON.stringify(receipts, null, 2)}\n`);
      return result;
    }
  });
  const result = await runAfterPendingMarketCleanup(cleanup, () => executeSemanticHarness({
    artifactDir, marketCleanup: cleanup, webUiRoot,
    seedPinsPath: path.join(directory, 'last-known-good.json'),
    catalog: 'bug-collaboration-probe',
    sessions: [{ id: `bug-collaboration-${phase}`, phase, client: 'codex',
      scenario: `bug-collaboration-${phase}`, codexSandbox: 'workspace-write',
      codexReportedTokenCeiling: 4000000,
      key: `codex-bug-collaboration/${phase}`, traceName: `codex-bug-collaboration-${phase}.jsonl`,
      description: phase === 'unresolved' ? 'original standalone concurrency bug' :
        'same bug with a primary-human selected concurrency default' }],
    reportProgress: (message) => process.stdout.write(`${message}\n`),
    dependencies: {
      createFixture: (options) => new BugCollaborationFixture(options),
      buildPrompt: (_session, targets) => `Start ${targets.bugCode}`,
      runAgentSession: runQuestionClosureNativeSession,
      assertTranscript: assertBugCollaborationTrace
    }
  }));
  const evidence = { mechanical_status: result.status,
    workflow_verdict: 'requires independent analysis of native history and durable state',
    artifact_dir: artifactDir, cleanup_receipts: receipts };
  // The store has already redacted each result. Reference its manifest instead
  // of publishing the in-memory credential-bearing snapshots a second time.
  fs.writeFileSync(path.join(artifactDir, 'probe-summary.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
