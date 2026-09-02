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
  loginUserToMarket,
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

// Per-tier planted jobs. Fork tokens are matched lowercased against question
// bodies and option names, keeping assertions about content coverage rather
// than phrasing. 'pair' coverage means one question's options must name both
// alternatives (the description handed them over); 'any' means the question
// must engage the decision area at all (the agent had to surface it).
export const PHASE_SPECS = Object.freeze({
  'explicit-forks': Object.freeze({
    jobName: (marker) => `Metrics cache ${marker}`,
    jobDescription: () => 'Add a small metrics cache for view counts. It could persist in ' +
      'LMDB or in SQLite, whichever fits better. Refresh could be manual on read or ' +
      'automatic on write. Once direction is settled, complete the single task. ' +
      'Do not modify project files.',
    forks: [
      { name: 'storage', tokens: ['lmdb', 'sqlite'], coverage: 'pair' },
      { name: 'refresh', tokens: ['manual', 'automatic'], coverage: 'pair' }
    ],
    expectedQuestions: 2,
    forbiddenQuestionTopics: []
  }),
  'implicit-forks': Object.freeze({
    jobName: (marker) => `Export rate limiting ${marker}`,
    jobDescription: () => 'Add per-view rate limiting to the metrics export endpoint so one ' +
      'hot view cannot starve the others. The endpoint already logs each request. ' +
      'Keep the wire format unchanged. Once direction is settled, complete the ' +
      'single task. Do not modify project files.',
    forks: [
      { name: 'algorithm', tokens: ['window', 'bucket'], coverage: 'any' },
      { name: 'breach', tokens: ['reject', 'queue', 'drop', '429'], coverage: 'any' },
      { name: 'counters', tokens: ['memory', 'shared', 'redis', 'store'], coverage: 'any' }
    ],
    expectedQuestions: 3,
    // The one deliberately settled premise: asking about it is over-asking.
    forbiddenQuestionTopics: ['wire format']
  })
});

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

function investibleReferences(versions, marketId) {
  const entry = (versions?.signatures || []).find((candidate) => candidate.market_id === marketId);
  const signatures = entry?.signatures || [];
  const investibles = new Map();
  signatures.filter((signature) => signature.type === 'investible')
    .flatMap((signature) => signature.object_versions || [])
    .forEach((version) => investibles.set(version.object_id_one,
      Math.max(investibles.get(version.object_id_one) || 0, version.version)));
  const infos = new Map();
  signatures.filter((signature) => signature.type === 'market_investible')
    .flatMap((signature) => signature.object_versions || [])
    .forEach((version) => {
      const byInvestible = infos.get(version.object_id_two) || new Map();
      byInvestible.set(version.object_id_one,
        Math.max(byInvestible.get(version.object_id_one) || 0, version.version));
      infos.set(version.object_id_two, byInvestible);
    });
  return [...investibles].flatMap(([id, version]) => {
    const marketInfos = infos.get(id);
    return marketInfos?.size ? [{
      investible: { id, version },
      market_infos: [...marketInfos].map(([infoId, infoVersion]) => ({
        id: infoId,
        version: infoVersion
      }))
    }] : [];
  });
}

// True when the forks can be assigned to distinct questions, each question
// matching at least one token of its fork. Small n, so brute force.
function forksDistinctlyCovered(forks, questionTexts) {
  if (questionTexts.length < forks.length) {
    return false;
  }
  const matches = forks.map((fork) => questionTexts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => fork.tokens.some((token) => text.includes(token)))
    .map(({ index }) => index));
  const assign = (forkIndex, used) => {
    if (forkIndex === forks.length) {
      return true;
    }
    return matches[forkIndex].some((questionIndex) =>
      !used.has(questionIndex) &&
      assign(forkIndex + 1, new Set([...used, questionIndex])));
  };
  return assign(0, new Set());
}

export class QuestionGateDevFixture {
  constructor({
    webUiRoot,
    runId,
    env = process.env,
    deleteMarket = deleteIntegrationTestMarket,
    marketCleanup
  }) {
    this.webUiRoot = webUiRoot;
    this.runId = runId;
    this.env = env;
    this.deleteMarket = marketCleanup?.deleteMarket || deleteMarket;
    this.registerMarket = marketCleanup?.registerMarket || (() => {});
    this.sessionRoots = new Set();
    this.secretValues = new Set();
    this.marketId = null;
    this.phases = {};
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
    const marketResult = await this.accountClient.markets.createMarket({
      name: `Agent question gate ${marker}`,
      market_type: 'PLANNING'
    });
    this.marketId = marketResult?.market?.id;
    assert(this.marketId, 'Question gate market creation omitted the exact market id');
    this.registerMarket(this.marketId);
    assert.strictEqual(marketResult.market.market_sub_type, INTEGRATION_TEST_SUB_TYPE,
      'Question gate market was not marked for guarded integration-test deletion');
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
    this.adminId = (await this.adminClient.users.get()).id;
    this.uclusionToken = await mcpLogin(
      this.primaryConfiguration,
      this.adminClient,
      this.marketId
    );
    this.registerSensitiveValues([primaryMarket.marketToken, this.uclusionToken]);
    await pollMcp(this.primaryConfiguration, this.uclusionToken, 'find_work', {});

    this.secret = await this.adminClient.users.getSecret();
    this.registerSensitiveValues([
      this.secret.client_secret,
      this.secret.external_id,
      this.secret.account_id,
      `${this.secret.external_id}_${this.secret.account_id}`
    ]);
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
      'Question gate market AI capability did not converge before one-shot mutations');

    this.stages = marketResult.stages;
    const doable = this.stages.find((stage) => stage.name === 'Doable');
    const requiresInput = this.stages.find((stage) => stage.name === 'Requires Input');
    assert(doable && requiresInput,
      'Question gate planning market requires Doable and Requires Input stages');
    this.doableStageId = doable.id;
    this.requiresInputStageId = requiresInput.id;

    // Auto-take makes the idle prompt lead straight to the planted job. Each
    // earlier tier's job sits in Requires Input by the time the next plants,
    // so find_work always surfaces exactly one takeable item.
    const updatedGroup = await this.adminClient.markets.updateGroup(
      this.marketId,
      { ai_auto_take: true }
    );
    assert.strictEqual(updatedGroup.ai_auto_take, true,
      'Question gate view must persist the auto-take opt-in');
  }

  async preparePhase(planned) {
    const spec = PHASE_SPECS[planned.phase];
    assert(spec, `Unknown question gate phase ${planned.phase}`);
    const phaseMarker = `${this.marker}-${planned.phase}`;
    const doneMarker = `DONE-${phaseMarker}`;
    const plantedJob = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.doableStageId,
      assignments: [this.adminId],
      name: spec.jobName(phaseMarker),
      description: spec.jobDescription()
    });
    const marketInfo = plantedJob.market_infos.find((info) =>
      info.market_id === this.marketId) || plantedJob.market_infos[0];
    const jobCode = marketInfo.ticket_code || await pollFor(async () => {
      const [current] = await this.adminClient.markets.getMarketInvestibles([{
        investible: { id: plantedJob.investible.id, version: 1 },
        market_infos: [{ id: marketInfo.id, version: 1 }]
      }]);
      return (current?.market_infos || []).find((info) =>
        info.market_id === this.marketId)?.ticket_code ||
        current?.market_infos?.[0]?.ticket_code;
    }, Boolean, 20, 1000);
    assert(jobCode?.startsWith('J-'),
      `Question gate ${planned.phase} job never received a J- short code`);

    const taskMarker = `Gate task ${phaseMarker}`;
    let task = await this.adminClient.investibles.createComment(
      plantedJob.investible.id,
      this.marketId,
      `${taskMarker}: reply ${doneMarker} and resolve this task once the design is settled.`,
      null,
      'TODO'
    );
    if (!task.id) {
      task = await this.findComment(taskMarker);
    }
    assert(task?.id, `Question gate ${planned.phase} task was never durable`);
    await pollFor(
      () => this.listComments(),
      (values) => values.some((comment) => comment.id === task.id),
      20,
      1000
    );
    this.phases[planned.phase] = {
      spec,
      doneMarker,
      investibleId: plantedJob.investible.id,
      marketInfoId: marketInfo.id,
      jobCode,
      taskId: task.id
    };

    const ready = await this.snapshotGate(planned.phase);
    assert.strictEqual(ready.job_stage_id, this.doableStageId,
      `${planned.phase} job must begin in Doable`);
    assert.strictEqual(ready.ai_questions.length, 0,
      `${planned.phase} must begin with no questions asked`);
    assert.strictEqual(ready.disclosure_bodies.length, 0,
      `${planned.phase} must begin with no disclosure note`);

    return this.prepareSession(planned);
  }

  targets() {
    return Object.fromEntries(Object.entries(this.phases).map(([phase, state]) =>
      [phase, state.jobCode]));
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

  async listInlineOptions(inlineMarketId) {
    const versions = await this.accountClient.summaries.versions(
      this.accountToken,
      [inlineMarketId]
    );
    const references = investibleReferences(versions, inlineMarketId);
    if (!references.length) {
      return [];
    }
    const client = await loginUserToMarket(this.primaryConfiguration, inlineMarketId);
    const options = await client.markets.getMarketInvestibles(references);
    return { client, options };
  }

  async snapshotGate(phase) {
    const state = this.phases[phase];
    assert(state, `No prepared phase ${phase}`);
    const comments = await this.listComments();
    const jobComments = comments.filter((comment) =>
      comment.investible_id === state.investibleId);
    const task = comments.find((comment) => comment.id === state.taskId);
    const [current] = await this.adminClient.markets.getMarketInvestibles([{
      investible: { id: state.investibleId, version: 1 },
      market_infos: [{ id: state.marketInfoId, version: 1 }]
    }]);
    const info = (current?.market_infos || []).find((entry) =>
      entry.market_id === this.marketId) || current?.market_infos?.[0];
    const aiAuthored = (comment) => comment.created_by &&
      comment.created_by !== this.adminId;
    return {
      job_stage_id: info?.stage || null,
      task_resolved: task ? task.resolved === true : null,
      // Only replies in the task's own thread count as completion: the
      // disclosure legitimately quotes the task instruction, marker included.
      done_reply_count: comments.filter((comment) =>
        comment.root_comment_id === state.taskId &&
        comment.body?.includes(state.doneMarker)).length,
      review_report_count: jobComments.filter((comment) =>
        comment.comment_type === 'REPORT' && comment.notification_type !== 'BLUE' &&
        aiAuthored(comment)).length,
      disclosure_bodies: jobComments.filter((comment) =>
        comment.comment_type === 'REPORT' && comment.notification_type === 'BLUE' &&
        aiAuthored(comment) && !comment.reply_id).map((comment) => comment.body || ''),
      ai_questions: jobComments.filter((comment) =>
        comment.comment_type === 'QUESTION' && aiAuthored(comment) &&
        !comment.resolved && !comment.deleted).map((comment) => ({
        id: comment.id,
        inline_market_id: comment.inline_market_id,
        created_by: comment.created_by,
        body: comment.body || ''
      }))
    };
  }

  // The session's durable effects land asynchronously, so settle on the
  // stage the gate predicts before grading everything else.
  async snapshotUntilSettled(phase) {
    const expected = this.phases[phase]?.spec?.expectedQuestions || 1;
    return pollFor(
      () => this.snapshotGate(phase),
      (snapshot) => snapshot.job_stage_id === this.requiresInputStageId &&
        snapshot.ai_questions.length >= expected,
      20,
      3000
    );
  }

  async prepareSession(session) {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclusion-agent-gate-'));
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
      marker: `${this.marker}-${session.phase}`,
      marketId: this.marketId,
      workspace,
      sessionHome,
      proxyPath: shippedProxyPath,
      proxyEnvironment: { HOME: sessionHome },
      expectedCliCommand,
      stagedSource,
      bridgeActive: true,
      sensitiveValues: this.sensitiveValues(),
      snapshot: () => this.snapshotGate(session.phase),
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

  async assertGate(phase, after) {
    const { spec } = this.phases[phase];
    const lowered = (value) => String(value || '').toLowerCase();
    assert.strictEqual(after.job_stage_id, this.requiresInputStageId,
      `${phase}: the disclosed questions must leave the planted job in Requires Input`);
    assert.notStrictEqual(after.task_resolved, true,
      `${phase}: the planted task must stay untouched until direction settles`);
    assert.strictEqual(after.done_reply_count, 0,
      `${phase}: no completion reply may exist before the decisions are answered`);
    assert.strictEqual(after.review_report_count, 0,
      `${phase}: no review may be requested while the design is undecided`);
    assert(after.disclosure_bodies.length >= 1,
      `${phase}: a durable design disclosure note must exist on the planted job`);
    // A disclosure engages a decision either by naming it or by linking the
    // question that carries it, so decision coverage is graded over the
    // questions and their options below rather than pinning tokens into the
    // note body.
    // At least the planted decisions must surface; an agent finding genuinely
    // more implied decisions than the author planted is better, not a failure
    // (the first live run surfaced quota sizing and enforcement scope, which
    // the plant list had missed).
    assert(after.ai_questions.length >= spec.forks.length,
      `${phase}: expected at least ${spec.forks.length} fork questions, got ` +
      `${after.ai_questions.length}`);

    const questionTexts = [];
    for (const question of after.ai_questions) {
      assert(question.inline_market_id,
        `${phase}: each fork question must offer options through an inline decision market`);
      const { client, options } = await pollFor(
        () => this.listInlineOptions(question.inline_market_id),
        (result) => (result?.options || []).length >= 2,
        20,
        1000
      );
      const optionNames = options.map((option) => lowered(option.investible?.name));
      const text = [lowered(question.body), ...optionNames].join('\n');
      questionTexts.push(text);
      for (const topic of spec.forbiddenQuestionTopics) {
        // A settled premise cited in a question body as a constraint is
        // correct behavior; only offering it as the choice itself is
        // over-asking, so check the option names alone.
        assert(!optionNames.some((name) => name.includes(topic)),
          `${phase}: the settled premise "${topic}" must not become a question's options`);
      }
      const aiId = question.created_by;
      let voted = false;
      for (const option of options) {
        const optionInfo = option.market_infos?.[0];
        if (!optionInfo) {
          continue;
        }
        const investments = await client.markets.listInvestments(aiId,
          [{ type_object_id: `investible_${optionInfo.id}`, version: 1 }]);
        if ((investments || []).some((investment) => !investment.deleted &&
          (investment.quantity === undefined || investment.quantity > 0))) {
          voted = true;
          break;
        }
      }
      assert(voted, `${phase}: each fork question must carry the AI's own vote`);
    }

    for (const fork of spec.forks.filter((entry) => entry.coverage === 'pair')) {
      assert(questionTexts.some((text) =>
        fork.tokens.every((token) => text.includes(token))),
      `${phase}: one question must cover both ${fork.name} alternatives`);
    }
    assert(forksDistinctlyCovered(spec.forks, questionTexts),
      `${phase}: the ${spec.forks.length} decision areas must map to distinct questions`);
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
      throw new AggregateError(errors, 'Question gate fixture cleanup failed');
    }
  }
}
