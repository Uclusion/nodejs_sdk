import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import awsAmplify from 'aws-amplify';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpLogin, pollFor } from '../tests/commonTestFunctions.js';
import {
  canonicalMarketSignature,
  deleteIntegrationTestMarket,
  parseDevCredentials
} from './devFixture.js';
import {
  COGNITO,
  DEV_ENDPOINTS,
  INTEGRATION_TEST_SUB_TYPE,
  pollMcp,
  seedCodexAuth,
  writeSessionState
} from './semanticFixture.js';
import { stageSourcePackage } from './sourcePackage.js';

const Amplify = awsAmplify.default;

function commentVersions(versions, marketId) {
  const entry = (versions?.signatures || []).find((candidate) => candidate.market_id === marketId);
  const result = new Map();
  (entry?.signatures || [])
    .filter((signature) => signature.type === 'comment')
    .flatMap((signature) => signature.object_versions || [])
    .forEach((version) => {
      result.set(version.object_id_one,
        Math.max(result.get(version.object_id_one) || 0, version.version));
    });
  return result;
}

export class WorkClaimsDevFixture {
  constructor({ webUiRoot, runId, env = process.env, deleteMarket = deleteIntegrationTestMarket }) {
    this.webUiRoot = webUiRoot;
    this.runId = runId;
    this.env = env;
    this.deleteMarket = deleteMarket;
    this.sessionRoots = new Set();
    this.secretValues = new Set();
    this.marketId = null;
    this.closed = false;
  }

  sensitiveValues() {
    return [...this.secretValues].filter(Boolean);
  }

  registerSensitiveValues(values) {
    const visit = (value) => {
      if (typeof value === 'string' && value) {
        this.secretValues.add(value);
      } else if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(visit);
      }
    };
    visit(values || []);
  }

  async initialize() {
    global.fetch = fetch;
    global.AbortController = AbortController;
    Amplify.configure({ Auth: COGNITO });
    const primary = parseDevCredentials(this.env);
    this.registerSensitiveValues([primary.raw, primary.username, primary.password]);
    this.primaryConfiguration = { ...DEV_ENDPOINTS,
      username: primary.username, password: primary.password };
    this.primaryConfiguration.idToken = await loginUserToIdentity(this.primaryConfiguration);
    this.registerSensitiveValues([this.primaryConfiguration.idToken]);

    const accountLogin = await loginUserToAccountAndGetToken(this.primaryConfiguration);
    this.accountClient = accountLogin.client;
    this.accountToken = accountLogin.accountToken;
    this.registerSensitiveValues([this.accountToken]);
    const marker = `${this.runId.slice(0, 8)}-${randomUUID().slice(0, 12)}`;
    this.marker = marker;
    this.doneMarker = `DONE-${marker}`;
    const marketResult = await this.accountClient.markets.createMarket({
      name: `Agent work claims ${marker}`,
      market_type: 'PLANNING'
    });
    this.marketId = marketResult?.market?.id;
    assert(this.marketId, 'Work claims market creation omitted the exact market id');
    assert.strictEqual(marketResult.market.market_sub_type, INTEGRATION_TEST_SUB_TYPE,
      'Work claims market was not marked for guarded integration-test deletion');
    this.registerSensitiveValues([marketResult.market.invite_capability]);

    await loginUserToMarketInvite(
      this.primaryConfiguration,
      marketResult.market.invite_capability
    );
    const primaryMarket = await loginUserToMarketAndGetToken(
      this.primaryConfiguration,
      this.marketId
    );
    this.adminClient = primaryMarket.client;
    this.marketToken = primaryMarket.marketToken;
    this.adminId = (await this.adminClient.users.get()).id;
    this.uclusionToken = await mcpLogin(
      this.primaryConfiguration,
      this.adminClient,
      this.marketId
    );
    this.registerSensitiveValues([this.marketToken, this.uclusionToken]);
    await pollMcp(this.primaryConfiguration, this.uclusionToken, 'find_work', {});

    this.secret = await this.adminClient.users.getSecret();
    this.registerSensitiveValues([
      this.secret.client_secret,
      this.secret.external_id,
      this.secret.account_id,
      `${this.secret.external_id}_${this.secret.account_id}`
    ]);
    // One human plus the planning AI must contribute capabilities before
    // one-shot writes, mirroring the semantic fixture's convergence gate.
    const capabilityReadyVersions = await pollFor(
      () => this.accountClient.summaries.versions(this.accountToken, [this.marketId]),
      (versions) => {
        const capabilities = canonicalMarketSignature(versions, this.marketId)
          .find((signature) => signature.type === 'market_capability');
        return (capabilities?.object_versions || []).length >= 2;
      },
      20,
      500
    );
    const readyCapabilities = canonicalMarketSignature(capabilityReadyVersions, this.marketId)
      .find((signature) => signature.type === 'market_capability');
    assert((readyCapabilities?.object_versions || []).length >= 2,
      'Work claims market AI capability did not converge before one-shot mutations');

    this.stages = marketResult.stages;
    const doable = this.stages.find((stage) => stage.name === 'Doable');
    assert(doable, 'Work claims planning market requires a Doable stage');
    this.doableStageId = doable.id;
    this.tasksCompleteStageId = this.stages.find((stage) =>
      stage.name === 'Tasks Complete')?.id || null;

    // The whole catalog depends on both agents taking work without asking, so
    // the view-level auto-take opt-in must be durably on before either starts.
    const updatedGroup = await this.adminClient.markets.updateGroup(
      this.marketId,
      { ai_auto_take: true }
    );
    assert.strictEqual(updatedGroup.ai_auto_take, true,
      'Work claims view must persist the auto-take opt-in');

    const contestedJob = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.doableStageId,
      assignments: [this.adminId],
      name: `Claim race ${marker}`,
      description: 'Live race fixture with exactly one unit of work. Complete the single ' +
        `task on this job by replying ${this.doneMarker} on it and resolving it. ` +
        'Do not resolve the enclosing job, do not modify files, and do not create ' +
        'questions, suggestions, or additional work.'
    });
    this.contestedJob = contestedJob;
    const marketInfo = contestedJob.market_infos.find((info) =>
      info.market_id === this.marketId) || contestedJob.market_infos[0];
    this.contestedMarketInfoId = marketInfo.id;
    this.contestedJobCode = marketInfo.ticket_code || await pollFor(async () => {
      const [current] = await this.adminClient.markets.getMarketInvestibles([{
        investible: { id: contestedJob.investible.id, version: 1 },
        market_infos: [{ id: marketInfo.id, version: 1 }]
      }]);
      return (current?.market_infos || []).find((info) =>
        info.market_id === this.marketId)?.ticket_code ||
        current?.market_infos?.[0]?.ticket_code;
    }, Boolean, 20, 1000);
    assert(this.contestedJobCode?.startsWith('J-'),
      'Work claims contested job never received a J- short code');

    this.taskMarker = `Race task ${marker}`;
    let task = await this.adminClient.investibles.createComment(
      contestedJob.investible.id,
      this.marketId,
      `${this.taskMarker}: reply ${this.doneMarker} on this task and resolve it.`,
      null,
      'TODO'
    );
    if (!task.id) {
      task = await this.findComment(this.taskMarker);
    }
    assert(task?.id, 'Work claims contested task was never durable');
    this.taskId = task.id;
    // The snapshot reads through the eventually consistent versions summary,
    // so wait until it can actually see the contested task before asserting
    // readiness from it.
    await pollFor(
      () => this.listComments(),
      (values) => values.some((comment) => comment.id === this.taskId),
      20,
      1000
    );

    const ready = await this.snapshotRace();
    assert.strictEqual(ready.job_stage_id, this.doableStageId,
      'Contested job must begin in Doable');
    assert.strictEqual(ready.task_resolved, false,
      'Contested task must begin unresolved');
    assert.strictEqual(ready.done_comment_count, 0,
      'The race must begin before any completion reply exists');
  }

  targets() {
    return {
      contestedJobCode: this.contestedJobCode,
      doneMarker: this.doneMarker
    };
  }

  async listComments() {
    const versions = await this.accountClient.summaries.versions(
      this.accountToken,
      [this.marketId]
    );
    const versionsById = commentVersions(versions, this.marketId);
    if (!versionsById.size) {
      return [];
    }
    return this.adminClient.investibles.getMarketComments(
      [...versionsById].map(([id, version]) => ({ id, version }))
    );
  }

  async findComment(marker) {
    const comments = await pollFor(
      () => this.listComments(),
      (values) => values.some((comment) => comment.body?.includes(marker)),
      20,
      1000
    );
    return comments.find((comment) => comment.body?.includes(marker));
  }

  async snapshotRace() {
    const comments = await this.listComments();
    const task = comments.find((comment) => comment.id === this.taskId);
    const [current] = await this.adminClient.markets.getMarketInvestibles([{
      investible: { id: this.contestedJob.investible.id, version: 1 },
      market_infos: [{ id: this.contestedMarketInfoId, version: 1 }]
    }]);
    const info = (current?.market_infos || []).find((entry) =>
      entry.market_id === this.marketId) || current?.market_infos?.[0];
    return {
      contested_code: this.contestedJobCode,
      job_stage_id: info?.stage || null,
      task_resolved: task ? task.resolved === true : null,
      done_comment_count: comments.filter((comment) =>
        comment.id !== this.taskId && comment.body?.includes(this.doneMarker)).length
    };
  }

  async prepareRacer(session) {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `uclusion-agent-claims-${session.racer}-`));
    this.sessionRoots.add(fixtureRoot);
    const workspace = path.join(fixtureRoot, 'workspace');
    const sessionHome = path.join(fixtureRoot, 'home');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionHome, { recursive: true });
    seedCodexAuth({
      env: this.env,
      sessionHome,
      registerSensitiveValues: (values) => this.registerSensitiveValues(values)
    });
    const cliPath = path.join(this.webUiRoot, 'public', 'scripts', 'uclusionCLI.py');
    const shippedProxyPath = path.join(
      this.webUiRoot, 'public', 'scripts', 'uclusionMCPProxy.py'
    );
    assert(fs.existsSync(cliPath), `Missing dev CLI source ${cliPath}`);
    assert(fs.existsSync(shippedProxyPath), `Missing dev MCP proxy source ${shippedProxyPath}`);
    writeSessionState({
      workspace,
      sessionHome,
      marketId: this.marketId,
      secret: this.secret
    });
    const expectedCliCommand = `${cliPath} -e dev`;
    const stagedSource = stageSourcePackage({
      webUiRoot: this.webUiRoot,
      workspace,
      client: 'codex',
      cliCommand: expectedCliCommand
    });
    let closed = false;
    return {
      runId: this.runId,
      marker: `${this.marker}-${session.racer}`,
      racer: session.racer,
      marketId: this.marketId,
      workspace,
      sessionHome,
      proxyPath: shippedProxyPath,
      proxyEnvironment: { HOME: sessionHome },
      // The whole catalog exists to watch real agents use the opt-in lock.
      proxyExtraArgs: ['--work-claims'],
      expectedCliCommand,
      stagedSource,
      bridgeActive: true,
      sensitiveValues: this.sensitiveValues(),
      snapshot: () => this.snapshotRace(),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        this.sessionRoots.delete(fixtureRoot);
      }
    };
  }

  assertRace(before, after) {
    assert.strictEqual(before.job_stage_id, this.doableStageId,
      'The race must begin from a Doable contested job');
    assert.strictEqual(before.task_resolved, false,
      'The race must begin with the contested task open');
    assert.strictEqual(before.done_comment_count, 0,
      'The race must begin before any completion reply exists');
    assert.strictEqual(after.task_resolved, true,
      'Exactly one racer must complete and resolve the contested task');
    assert.strictEqual(after.done_comment_count, 1,
      'The contested work must be done exactly once, never duplicated');
    if (this.tasksCompleteStageId) {
      assert.notStrictEqual(after.job_stage_id, this.tasksCompleteStageId,
        'No racer may resolve the enclosing contested job');
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors = [];
    for (const root of [...this.sessionRoots]) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        this.sessionRoots.delete(root);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.marketId) {
      let deletionError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.deleteMarket(this.marketId);
          deletionError = undefined;
          this.marketId = null;
          break;
        } catch (error) {
          deletionError = error;
        }
      }
      if (deletionError) {
        errors.push(deletionError);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Work claims fixture cleanup failed');
    }
  }
}
