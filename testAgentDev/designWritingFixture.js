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
import { assertDesignWritingState } from './designWritingAssertions.js';
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

const CHOICES = Object.freeze([
  Object.freeze({
    key: 'delivery',
    question: 'How should a completed usage export reach the workspace owner?',
    options: Object.freeze([
      'Expiring download link',
      'Email attachment'
    ]),
    selectedIndex: 0,
    claimTermGroups: Object.freeze([
      Object.freeze(['owner']),
      Object.freeze(['ready', 'complete']),
      Object.freeze(['download', 'link']),
      Object.freeze(['expir'])
    ])
  }),
  Object.freeze({
    key: 'failure',
    question: 'What should remain visible when a later usage export fails?',
    options: Object.freeze([
      'Replace the result with failure only',
      'Keep the last successful export visible'
    ]),
    selectedIndex: 1,
    claimTermGroups: Object.freeze([
      Object.freeze(['owner']),
      Object.freeze(['fail']),
      Object.freeze(['last successful', 'previous successful']),
      Object.freeze(['visible', 'keep', 'preserv'])
    ])
  })
]);

function commentVersions(versions, marketId) {
  const entry = (versions?.signatures || []).find((candidate) =>
    candidate.market_id === marketId);
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
  const entry = (versions?.signatures || []).find((candidate) =>
    candidate.market_id === marketId);
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

function isCurrentJobCapsule(comment, jobId) {
  return comment.investible_id === jobId &&
    comment.comment_type === 'REPORT' &&
    comment.notification_type === 'BLUE' &&
    comment.pinned === true &&
    !comment.associated_comment_id &&
    !comment.reply_id &&
    !comment.root_comment_id &&
    comment.is_sent === true &&
    comment.is_machine_only !== true &&
    comment.resolved !== true &&
    comment.deleted !== true;
}

export class DesignWritingDevFixture {
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
    this.primaryConfiguration = {
      ...DEV_ENDPOINTS,
      username: primary.username,
      password: primary.password
    };
    this.primaryConfiguration.idToken = await loginUserToIdentity(this.primaryConfiguration);
    this.registerSensitiveValues([this.primaryConfiguration.idToken]);

    const accountLogin = await loginUserToAccountAndGetToken(this.primaryConfiguration);
    this.accountClient = accountLogin.client;
    this.accountToken = accountLogin.accountToken;
    this.registerSensitiveValues([this.accountToken]);
    this.marker = `${this.runId.slice(0, 8)}-${randomUUID().slice(0, 12)}`;
    const marketResult = await this.accountClient.markets.createMarket({
      name: `Agent design writing ${this.marker}`,
      market_type: 'PLANNING'
    });
    this.marketId = marketResult?.market?.id;
    assert(this.marketId, 'Design-writing market creation omitted the exact market id');
    this.registerMarket(this.marketId);
    assert.strictEqual(marketResult.market.market_sub_type, INTEGRATION_TEST_SUB_TYPE,
      'Design-writing market was not marked for guarded integration-test deletion');
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
    const capabilityVersions = await pollFor(
      () => this.accountClient.summaries.versions(this.accountToken, [this.marketId]),
      (versions) => {
        const capabilities = canonicalMarketSignature(versions, this.marketId)
          .find((signature) => signature.type === 'market_capability');
        return (capabilities?.object_versions || []).length >= 2;
      },
      20,
      500
    );
    const capabilities = canonicalMarketSignature(capabilityVersions, this.marketId)
      .find((signature) => signature.type === 'market_capability');
    assert((capabilities?.object_versions || []).length >= 2,
      'Design-writing market AI capability did not converge before fixture writes');

    const doable = marketResult.stages.find((stage) => stage.name === 'Doable');
    assert(doable, 'Design-writing planning market requires a Doable stage');
    this.doableStageId = doable.id;
    this.job = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.doableStageId,
      assignments: [this.adminId],
      name: `Usage export design ${this.marker}`,
      description: this.designJobDescription()
    });
    const marketInfo = this.job.market_infos.find((info) =>
      info.market_id === this.marketId) || this.job.market_infos[0];
    this.jobMarketInfoId = marketInfo.id;
    this.jobCode = marketInfo.ticket_code || await pollFor(async () => {
      const current = await this.currentJob();
      const info = current?.market_infos?.find((entry) =>
        entry.market_id === this.marketId) || current?.market_infos?.[0];
      return info?.ticket_code;
    }, Boolean, 20, 1000);
    assert(this.jobCode?.startsWith('J-'),
      'Design-writing job never received a J- short code');

    this.choices = [];
    for (const definition of CHOICES) {
      this.choices.push(await this.createResolvedChoice(definition));
    }
    const ready = await pollFor(
      () => this.snapshotDesign(),
      (snapshot) => snapshot.job.stage_id === this.doableStageId &&
        snapshot.choices.length === CHOICES.length &&
        snapshot.choices.every((choice) => choice.resolved && choice.selected_by_primary) &&
        snapshot.capsules.length === 0,
      20,
      1000
    );
    assertDesignWritingState({
      before: ready,
      after: ready,
      targets: this.targets(),
      fixtureOnly: true
    });
  }

  designJobDescription() {
    this.lifecycleMarkers = [
      `DW_ACTOR_TRIGGER_${this.marker}`,
      `DW_TERMINAL_SUCCESS_${this.marker}`,
      `DW_TERMINAL_FAILURE_${this.marker}`
    ];
    const [actorTrigger, success, failure] = this.lifecycleMarkers;
    return 'Create only the current intent/design capsule. Preserve these literal lifecycle ' +
      `anchors in this order: ${actorTrigger}: a workspace owner requests a usage export; ` +
      `${success}: generation completes and the export is ready for the owner; ${failure}: ` +
      'generation fails for the owner. The two resolved questions on this job authorize the ' +
      'delivery and failure behavior. Do not modify project files, resolve the job, or ' +
      'request review.';
  }

  async currentJob() {
    const [current] = await this.adminClient.markets.getMarketInvestibles([{
      investible: { id: this.job.investible.id, version: 1 },
      market_infos: [{ id: this.jobMarketInfoId, version: 1 }]
    }]);
    return current;
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

  async listInvestibles(marketId) {
    const versions = await this.accountClient.summaries.versions(
      this.accountToken,
      [marketId]
    );
    const references = investibleReferences(versions, marketId);
    if (!references.length) {
      return [];
    }
    const client = await loginUserToMarket(this.primaryConfiguration, marketId);
    return {
      client,
      investibles: await client.markets.getMarketInvestibles(references)
    };
  }

  async createResolvedChoice(definition) {
    const questionMarker = `${definition.question} ${this.marker}`;
    const optionNames = definition.options.map((name) => `${name} ${this.marker}`);
    const response = await pollMcp(
      this.primaryConfiguration,
      this.uclusionToken,
      'ask_question',
      {
        job_id: this.jobCode,
        question: questionMarker,
        options: optionNames.map((name) => ({
          name,
          description: `${name}. This is fixture behavior for the capsule acceptance run.`
        }))
      }
    );
    const returnedCodes = [...new Set(response.match(/\bQ-[A-Za-z0-9-]+\b/g) || [])];
    assert.strictEqual(returnedCodes.length, 1,
      `Design-writing ask_question must return one Q- code: ${response}`);
    const question = await this.findComment(questionMarker);
    assert.strictEqual(question?.ticket_code, returnedCodes[0],
      'Design-writing question did not retain its returned Q- code');
    assert(question.inline_market_id,
      'Design-writing question did not create an inline option market');
    assert.notStrictEqual(question.created_by, this.adminId,
      'Design-writing question must be authored by the planning AI');

    const inline = await pollFor(
      () => this.listInvestibles(question.inline_market_id),
      (result) => result?.investibles?.length === optionNames.length &&
        result.investibles.every((option) => option.market_infos?.some((info) =>
          info.ticket_code?.startsWith('O-'))),
      20,
      1000
    );
    const options = optionNames.map((name) => inline.investibles.find((option) =>
      option.investible.name === name));
    assert(options.every(Boolean),
      'Design-writing inline options did not preserve their exact planted names');
    const selected = options[definition.selectedIndex];
    const selectedInfo = selected.market_infos.find((info) =>
      info.ticket_code?.startsWith('O-'));
    await inline.client.markets.updateInvestment(selected.investible.id, 100, 0);
    await pollFor(
      () => inline.client.markets.listInvestments(this.adminId, [{
        type_object_id: `investible_${selectedInfo.id}`,
        version: 1
      }]),
      (investments) => (investments || []).some((investment) =>
        !investment.deleted &&
        (investment.quantity === undefined || investment.quantity > 0)),
      20,
      1000
    );
    await pollMcp(this.primaryConfiguration, this.uclusionToken, 'resolve', {
      short_code_id: question.ticket_code
    });
    await pollFor(
      async () => {
        const [comments, current] = await Promise.all([
          this.listComments(),
          this.currentJob()
        ]);
        const durableQuestion = comments.find((comment) => comment.id === question.id);
        const info = current?.market_infos?.find((entry) =>
          entry.market_id === this.marketId) || current?.market_infos?.[0];
        return {
          resolved: durableQuestion?.resolved === true,
          stageId: info?.stage
        };
      },
      (state) => state.resolved && state.stageId === this.doableStageId,
      20,
      1000
    );
    return {
      key: definition.key,
      questionId: question.id,
      questionCode: question.ticket_code,
      selectedOptionId: selected.investible.id,
      selectedOptionInfoId: selectedInfo.id,
      selectedOptionCode: selectedInfo.ticket_code,
      selectedOptionName: definition.options[definition.selectedIndex],
      claimTermGroups: definition.claimTermGroups,
      inlineClient: inline.client
    };
  }

  targets() {
    return {
      adminId: this.adminId,
      doableStageId: this.doableStageId,
      jobCode: this.jobCode,
      startEvent: this.jobCode ? `Start ${this.jobCode}` : undefined,
      lifecycleMarkers: [...this.lifecycleMarkers],
      actorTermGroups: [
        ['workspace owner'],
        ['request'],
        ['usage export', 'export'],
        ['generat'],
        ['ready', 'success'],
        ['fail']
      ],
      choices: this.choices.map((choice) => ({
        key: choice.key,
        questionCode: choice.questionCode,
        optionCode: choice.selectedOptionCode,
        optionName: choice.selectedOptionName,
        claimTermGroups: choice.claimTermGroups
      }))
    };
  }

  async selectedByPrimary(choice) {
    const investments = await choice.inlineClient.markets.listInvestments(
      this.adminId,
      [{
        type_object_id: `investible_${choice.selectedOptionInfoId}`,
        version: 1
      }]
    );
    return (investments || []).some((investment) => !investment.deleted &&
      (investment.quantity === undefined || investment.quantity > 0));
  }

  async snapshotDesign() {
    const [current, comments, markdown, selected] = await Promise.all([
      this.currentJob(),
      this.listComments(),
      pollMcp(this.primaryConfiguration, this.uclusionToken, 'get_job', {
        short_code_id: this.jobCode
      }),
      Promise.all(this.choices.map((choice) => this.selectedByPrimary(choice)))
    ]);
    const info = current?.market_infos?.find((entry) =>
      entry.market_id === this.marketId) || current?.market_infos?.[0];
    const capsules = comments.filter((comment) =>
      isCurrentJobCapsule(comment, this.job.investible.id));
    return {
      job: {
        code: info?.ticket_code || this.jobCode,
        created_by: current?.investible?.created_by || null,
        description: current?.investible?.description || '',
        assignments: [...(
          info?.assigned ?? info?.assignments ?? current?.investible?.assignments ?? []
        )].sort(),
        stage_id: info?.stage || null,
        resolved: current?.investible?.resolved === true
      },
      choices: this.choices.map((choice, index) => {
        const question = comments.find((comment) => comment.id === choice.questionId);
        return {
          key: choice.key,
          question_code: question?.ticket_code || choice.questionCode,
          option_code: choice.selectedOptionCode,
          resolved: question?.resolved === true,
          selected_by_primary: selected[index]
        };
      }),
      open_question_count: comments.filter((comment) =>
        comment.investible_id === this.job.investible.id &&
        comment.comment_type === 'QUESTION' &&
        !comment.resolved && !comment.deleted).length,
      capsules: capsules.map((capsule) => ({
        code: capsule.ticket_code,
        body: capsule.body || '',
        created_by: capsule.created_by,
        version: capsule.version,
        pinned: capsule.pinned,
        associated_comment_id: capsule.associated_comment_id || null
      })),
      markdown
    };
  }

  async snapshotSemantic() {
    return this.snapshotDesign();
  }

  async snapshotAfterPhase() {
    return pollFor(
      () => this.snapshotDesign(),
      (snapshot) => snapshot.capsules.length >= 1 &&
        snapshot.markdown.includes(snapshot.capsules[0].code),
      20,
      3000
    );
  }

  async preparePhase(session) {
    assert.strictEqual(session.phase, 'design-writing',
      `Unknown design-writing phase ${session.phase}`);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclusion-agent-design-'));
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
    const proxyPath = path.join(
      this.webUiRoot,
      'public',
      'scripts',
      'uclusionMCPProxy.py'
    );
    assert(fs.existsSync(cliPath), `Missing dev CLI source ${cliPath}`);
    assert(fs.existsSync(proxyPath), `Missing dev MCP proxy source ${proxyPath}`);
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
      marker: this.marker,
      marketId: this.marketId,
      workspace,
      sessionHome,
      proxyPath,
      proxyEnvironment: { HOME: sessionHome },
      expectedCliCommand,
      expectedEvent: `Start ${this.jobCode}`,
      stagedSource,
      bridgeActive: true,
      sensitiveValues: this.sensitiveValues(),
      snapshot: () => this.snapshotDesign(),
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

  assertPhase(_phase, before, after) {
    assertDesignWritingState({ before, after, targets: this.targets() });
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
      throw new AggregateError(errors, 'Design-writing fixture cleanup failed');
    }
  }
}
