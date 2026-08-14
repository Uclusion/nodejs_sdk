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
import { mcpCall, mcpLogin, pollFor } from '../tests/commonTestFunctions.js';
import {
  canonicalMarketSignature,
  deleteIntegrationTestMarket,
  parseDevCredentials
} from './devFixture.js';
import { stageSourcePackage } from './sourcePackage.js';

const Amplify = awsAmplify.default;
const DEV_ENDPOINTS = Object.freeze({
  baseURL: 'https://dev.api.uclusion.com/v1',
  websocketURL: 'wss://dev.ws.uclusion.com/v1'
});
const COGNITO = Object.freeze({
  userPoolId: 'us-west-2_DF7pMdI6r',
  userPoolWebClientId: '375e3ronmppclr3onap4ndguvi',
  region: 'us-west-2'
});
const INTEGRATION_TEST_SUB_TYPE = 'INTEGRATION_TEST';
const ADVISORY_REPLY =
  '##### Advisory response from non-primary human: does not answer this question.';
const ADVISORY_VOTE =
  '#### Advisory vote from non-primary human: does not answer this question.';

function seedCodexAuth({ env, sessionHome, registerSensitiveValues }) {
  if (env.TEST_AGENT_DEV_USE_LOCAL_AUTH !== '1') {
    return;
  }
  const sourceHome = env.HOME || os.homedir();
  const sourceRoot = env.CODEX_HOME || path.join(sourceHome, '.codex');
  const sourcePath = path.join(sourceRoot, 'auth.json');
  const sourceStat = fs.lstatSync(sourcePath);
  assert(sourceStat.isFile() && !sourceStat.isSymbolicLink(),
    `Local codex authentication must be a regular file: ${sourcePath}`);
  const authBytes = fs.readFileSync(sourcePath, 'utf8');
  let auth;
  try {
    auth = JSON.parse(authBytes);
  } catch (error) {
    throw new Error(`Local codex authentication is not valid JSON: ${sourcePath}`, {
      cause: error
    });
  }
  const targetPath = path.join(sessionHome, '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(targetPath, 0o600);
  // The artifact redactor replaces exact strings. Register every JSON leaf as
  // well as the original document so an individually emitted token cannot
  // escape merely because the surrounding auth object was omitted.
  registerSensitiveValues([authBytes, auth]);
}

async function pollMcp(configuration, token, name, args) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await mcpCall(configuration, token, name, args);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < 20) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  throw lastError;
}

async function ticketCodeFor(client, marketId, fullInvestible) {
  const marketInfo = fullInvestible.market_infos.find((info) => info.market_id === marketId) ||
    fullInvestible.market_infos[0];
  if (marketInfo?.ticket_code) {
    return marketInfo.ticket_code;
  }
  const code = await pollFor(async () => {
    const [current] = await client.markets.getMarketInvestibles([{
      investible: { id: fullInvestible.investible.id, version: 1 },
      market_infos: [{ id: marketInfo.id, version: 1 }]
    }]);
    return (current?.market_infos || []).find((info) => info.market_id === marketId)?.ticket_code ||
      current?.market_infos?.[0]?.ticket_code;
  }, Boolean, 20, 1000);
  assert(code, `Ticket code missing for ${fullInvestible.investible.id}`);
  return code;
}

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

function writeSessionState({ workspace, sessionHome, marketId, secret }) {
  const uclusionHome = path.join(sessionHome, '.uclusion');
  fs.mkdirSync(uclusionHome, { recursive: true });
  fs.writeFileSync(path.join(uclusionHome, 'dev_credentials'),
    `secret_key_id=${secret.external_id}_${secret.account_id}\n` +
      `secret_key=${secret.client_secret}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(uclusionHome, 'update_check.json'),
    `${JSON.stringify({ dev: { checked_at: Date.now() / 1000 } })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'dev_uclusion.json'), `${JSON.stringify({
    workspaceId: marketId,
    extensionsList: ['json'],
    sourcesList: ['./probe.json'],
    uclusionMDFileType: 'report',
    uclusionMDFilePath: 'uclusion.md'
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, 'probe.json'), '{"semantic_fixture":true}\n');
}

export function parseAdvisoryDevCredentials(env = process.env) {
  const raw = env.UCLUSION_DEV_ADVISORY_CREDENTIALS;
  assert(raw?.trim(),
    'UCLUSION_DEV_ADVISORY_CREDENTIALS must be JSON with nonempty username and password fields');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('UCLUSION_DEV_ADVISORY_CREDENTIALS is not valid JSON', { cause: error });
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    'UCLUSION_DEV_ADVISORY_CREDENTIALS must be a JSON object');
  assert.strictEqual(typeof parsed.username, 'string',
    'UCLUSION_DEV_ADVISORY_CREDENTIALS.username must be a string');
  assert.strictEqual(typeof parsed.password, 'string',
    'UCLUSION_DEV_ADVISORY_CREDENTIALS.password must be a string');
  assert(parsed.username.trim(),
    'UCLUSION_DEV_ADVISORY_CREDENTIALS.username must not be empty');
  assert(parsed.password, 'UCLUSION_DEV_ADVISORY_CREDENTIALS.password must not be empty');
  return { raw, username: parsed.username.trim(), password: parsed.password };
}

export class SemanticDevFixture {
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
    const advisory = parseAdvisoryDevCredentials(this.env);
    this.registerSensitiveValues([
      primary.raw, primary.username, primary.password,
      advisory.raw, advisory.username, advisory.password
    ]);
    this.primaryConfiguration = { ...DEV_ENDPOINTS,
      username: primary.username, password: primary.password };
    this.advisoryConfiguration = { ...DEV_ENDPOINTS,
      username: advisory.username, password: advisory.password };
    this.primaryConfiguration.idToken = await loginUserToIdentity(this.primaryConfiguration);
    this.advisoryConfiguration.idToken = await loginUserToIdentity(this.advisoryConfiguration);
    this.registerSensitiveValues([
      this.primaryConfiguration.idToken,
      this.advisoryConfiguration.idToken
    ]);

    const accountLogin = await loginUserToAccountAndGetToken(this.primaryConfiguration);
    this.accountClient = accountLogin.client;
    this.accountToken = accountLogin.accountToken;
    this.registerSensitiveValues([this.accountToken]);
    const marker = `${this.runId.slice(0, 8)}-${randomUUID().slice(0, 12)}`;
    this.marker = marker;
    const marketResult = await this.accountClient.markets.createMarket({
      name: `Agent semantic ${marker}`,
      market_type: 'PLANNING'
    });
    this.marketId = marketResult?.market?.id;
    assert(this.marketId, 'Semantic market creation omitted the exact market id');
    assert.strictEqual(marketResult.market.market_sub_type, INTEGRATION_TEST_SUB_TYPE,
      'Semantic market was not marked for guarded integration-test deletion');
    this.registerSensitiveValues([marketResult.market.invite_capability]);

    await loginUserToMarketInvite(
      this.primaryConfiguration,
      marketResult.market.invite_capability
    );
    await loginUserToMarketInvite(
      this.advisoryConfiguration,
      marketResult.market.invite_capability
    );
    const primaryMarket = await loginUserToMarketAndGetToken(
      this.primaryConfiguration,
      this.marketId
    );
    this.adminClient = primaryMarket.client;
    this.marketToken = primaryMarket.marketToken;
    this.advisoryClient = await loginUserToMarket(
      this.advisoryConfiguration,
      this.marketId
    );
    this.adminId = (await this.adminClient.users.get()).id;
    this.advisoryId = (await this.advisoryClient.users.get()).id;
    assert.notStrictEqual(this.adminId, this.advisoryId,
      'Semantic fixture requires two distinct real human identities');
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
    const capabilityReadyVersions = await pollFor(
      () => this.accountClient.summaries.versions(this.accountToken, [this.marketId]),
      (versions) => {
        const capabilities = canonicalMarketSignature(versions, this.marketId)
          .find((signature) => signature.type === 'market_capability');
        // Both joined humans already contribute capabilities. Wait for the
        // planning AI capability as the third member before one-shot writes.
        return (capabilities?.object_versions || []).length >= 3;
      },
      20,
      500
    );
    const readyCapabilities = canonicalMarketSignature(capabilityReadyVersions, this.marketId)
      .find((signature) => signature.type === 'market_capability');
    assert((readyCapabilities?.object_versions || []).length >= 3,
      'Semantic market AI capability did not converge before one-shot mutations');

    this.stages = marketResult.stages;
    const doable = this.stages.find((stage) => stage.name === 'Doable');
    const requiresInput = this.stages.find((stage) => stage.name === 'Requires Input');
    assert(doable && requiresInput,
      'Semantic planning market requires Doable and Requires Input stages');
    this.doableStageId = doable.id;
    this.requiresInputStageId = requiresInput.id;
    this.authorityQuestionMarker = `Authority choice ${marker}`;
    this.authorityTaskMarker = `Harmless continuation ${marker}`;
    this.advisoryReplyMarker = `Advisory evidence ${marker}`;
    this.primaryReplyMarker = `Primary answer ${marker}`;
    const authorityJob = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.doableStageId,
      assignments: [this.adminId],
      name: `Authority semantic ${marker}`,
      description: 'Live workflow fixture. Advisory input informs reasoning but must leave the ' +
        'question unresolved and the job in Requires Input. After primary input arrives, resolve ' +
        'the question and then resolve the harmless continuation task. Do not modify files, ' +
        'resolve the enclosing job, or work on unrelated items.'
    });
    this.authorityJob = authorityJob;
    this.authorityJobCode = await ticketCodeFor(
      this.adminClient,
      this.marketId,
      authorityJob
    );
    assert(this.authorityJobCode.startsWith('J-'),
      'Semantic authority job never received a J- short code');
    this.authorityTask = await this.adminClient.investibles.createComment(
      authorityJob.investible.id,
      this.marketId,
      this.authorityTaskMarker,
      null,
      'TODO'
    );
    this.authorityTask = this.authorityTask.ticket_code
      ? this.authorityTask
      : await this.findComment(this.authorityTaskMarker);
    assert(this.authorityTask?.ticket_code?.startsWith('T-'),
      'Semantic harmless task never received a T- short code');

    const asked = await mcpCall(this.primaryConfiguration, this.uclusionToken, 'ask_question', {
      job_id: this.authorityJobCode,
      question: `${this.authorityQuestionMarker}?`,
      options: [
        { name: `Conservative route ${marker}`, description: 'Use the narrow harmless route.' },
        { name: `Direct route ${marker}`, description: 'Use the direct harmless route.' }
      ]
    });
    const questionCodes = [...new Set(asked.match(/\bQ-[A-Za-z0-9-]+\b/g) || [])];
    assert.strictEqual(questionCodes.length, 1,
      `Semantic ask_question must return exactly one question code: ${asked}`);
    this.authorityQuestion = await this.findComment(this.authorityQuestionMarker);
    assert(this.authorityQuestion?.inline_market_id && this.authorityQuestion.ticket_code,
      'Semantic authority question did not create an inline decision market');
    assert.strictEqual(this.authorityQuestion.ticket_code, questionCodes[0],
      'Semantic authority question must preserve the exact returned Q- code');
    assert(typeof this.authorityQuestion.created_by === 'string' &&
      this.authorityQuestion.created_by.trim(),
    'Semantic authority question must expose its exact author');
    assert(![this.adminId, this.advisoryId].includes(this.authorityQuestion.created_by),
      'Semantic authority question must be authored by the planning AI');
    this.aiId = this.authorityQuestion.created_by;
    this.authorityQuestionCode = this.authorityQuestion.ticket_code;
    const optionIds = await pollFor(
      () => this.listInvestibles(this.authorityQuestion.inline_market_id),
      (values) => values.length >= 2 && values.every((value) =>
        value.market_infos?.some((info) => info.ticket_code)),
      20,
      1000
    );
    assert(optionIds.length >= 2 && optionIds.every((option) =>
      option.market_infos?.some((info) => info.ticket_code)),
    'Semantic authority question needs two durable short-coded options');
    this.authorityOptions = optionIds.slice(0, 2).map((option) => ({
      id: option.investible.id,
      code: option.market_infos.find((info) => info.ticket_code)?.ticket_code
    }));
    assert(this.authorityOptions.every((option) => option.code?.startsWith('O-')),
      'Semantic authority choices must expose exact O- option codes');
    this.inlineAdvisoryClient = await pollFor(
      () => loginUserToMarket(
        this.advisoryConfiguration,
        this.authorityQuestion.inline_market_id
      ),
      Boolean,
      20,
      1000
    );
    this.inlineAdminClient = await pollFor(
      () => loginUserToMarket(
        this.primaryConfiguration,
        this.authorityQuestion.inline_market_id
      ),
      Boolean,
      20,
      1000
    );

    const ready = await this.snapshotSemantic();
    assert.strictEqual(ready.authority.stage_id, this.requiresInputStageId,
      'Open semantic authority question must begin in Requires Input');
    assert.deepStrictEqual(ready.authority.assignments, [this.adminId],
      'Semantic authority job must begin assigned only to the primary human');
  }

  targets() {
    return {
      authorityJobCode: this.authorityJobCode,
      authorityQuestionCode: this.authorityQuestionCode,
      authorityTaskCode: this.authorityTask.ticket_code,
      authorityOptionCodes: this.authorityOptions?.map((option) => option.code),
      questionCode: this.authorityQuestionCode,
      taskCode: this.authorityTask.ticket_code,
      bugCode: this.standaloneBug?.ticket_code,
      standaloneBugCode: this.standaloneBug?.ticket_code,
      advisoryEvent: this.advisoryEvent,
      primaryEvent: this.primaryEvent,
      bugStartEvent: this.standaloneBug?.ticket_code
        ? `Start ${this.standaloneBug.ticket_code}`
        : undefined
    };
  }

  async listComments(targetMarketId = this.marketId, client = this.adminClient) {
    const versions = await this.accountClient.summaries.versions(
      this.accountToken,
      [targetMarketId]
    );
    const versionsById = commentVersions(versions, targetMarketId);
    if (!versionsById.size) {
      return [];
    }
    return client.investibles.getMarketComments(
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

  async listInvestibles(targetMarketId = this.marketId) {
    const versions = await this.accountClient.summaries.versions(
      this.accountToken,
      [targetMarketId]
    );
    const references = investibleReferences(versions, targetMarketId);
    if (!references.length) {
      return [];
    }
    const client = targetMarketId === this.marketId
      ? this.adminClient
      : await loginUserToMarket(this.primaryConfiguration, targetMarketId);
    return client.markets.getMarketInvestibles(references);
  }

  async currentAuthorityJob() {
    const info = this.authorityJob.market_infos.find((entry) =>
      entry.market_id === this.marketId) || this.authorityJob.market_infos[0];
    const [current] = await this.adminClient.markets.getMarketInvestibles([{
      investible: { id: this.authorityJob.investible.id, version: 1 },
      market_infos: [{ id: info.id, version: 1 }]
    }]);
    return current;
  }

  async snapshotSemantic() {
    const [currentJob, comments, markdown] = await Promise.all([
      this.currentAuthorityJob(),
      this.listComments(),
      pollMcp(this.primaryConfiguration, this.uclusionToken, 'get_job', {
        short_code_id: this.authorityJobCode
      })
    ]);
    const jobInfo = currentJob.market_infos.find((entry) => entry.market_id === this.marketId) ||
      currentJob.market_infos[0];
    const question = comments.find((comment) => comment.id === this.authorityQuestion.id);
    const task = comments.find((comment) => comment.id === this.authorityTask.id);
    const advisoryReply = comments.find((comment) =>
      comment.body?.includes(this.advisoryReplyMarker));
    const primaryReply = comments.find((comment) =>
      comment.body?.includes(this.primaryReplyMarker));
    const bug = this.standaloneBug
      ? comments.find((comment) => comment.id === this.standaloneBug.id)
      : undefined;
    const bugReply = this.standaloneBugReply
      ? comments.find((comment) => comment.id === this.standaloneBugReply.id)
      : undefined;
    const bugQuestion = this.bugQuestionMarker
      ? comments.find((comment) =>
        comment.body === this.bugQuestionStoredBody &&
          comment.comment_type === 'QUESTION' &&
          (!bug?.investible_id || comment.investible_id === bug.investible_id))
      : undefined;
    let bugJob;
    if (bug?.investible_id) {
      bugJob = (await this.listInvestibles()).find((investible) =>
        investible.investible.id === bug.investible_id);
    }
    const bugOptions = bugQuestion?.inline_market_id
      ? await this.listInvestibles(bugQuestion.inline_market_id)
      : [];
    const bugInfo = bugJob?.market_infos?.find((entry) => entry.market_id === this.marketId) ||
      bugJob?.market_infos?.[0];
    return {
      authority: {
        stage_id: jobInfo.stage,
        job_resolved: Boolean(currentJob.investible.resolved),
        assignments: [...(
          jobInfo.assigned ?? jobInfo.assignments ?? currentJob.investible.assignments ?? []
        )].sort(),
        question_created_by: question?.created_by || null,
        question_resolved: Boolean(question?.resolved),
        advisory_reply_created_by: advisoryReply?.created_by || null,
        primary_reply_created_by: primaryReply?.created_by || null,
        task_resolved: Boolean(task?.resolved),
        markdown
      },
      bug: bug ? {
        root_id: bug.id,
        root_type: bug.comment_type,
        root_investible_id: bug.investible_id || null,
        reply_investible_id: bugReply?.investible_id || null,
        job_code: bugInfo?.ticket_code || null,
        job_name: bugJob?.investible?.name || null,
        job_created_by: bugJob?.investible?.created_by || null,
        job_assignments: [...(
          bugInfo?.assigned ?? bugInfo?.assignments ?? bugJob?.investible?.assignments ?? []
        )].sort(),
        job_stage_id: bugInfo?.stage || null,
        question_code: bugQuestion?.ticket_code || null,
        question_body: bugQuestion?.body || null,
        question_created_by: bugQuestion?.created_by || null,
        question_resolved: bugQuestion ? Boolean(bugQuestion.resolved) : null,
        option_names: bugOptions.map((option) => option.investible.name).sort(),
        option_codes: bugOptions.map((option) =>
          option.market_infos?.find((info) => info.ticket_code)?.ticket_code
        ).filter(Boolean).sort()
      } : null
    };
  }

  async snapshotAfterPhase(phase) {
    const converged = (state) => {
      if (phase === 'advisory-stop') {
        return state.authority.stage_id === this.requiresInputStageId &&
          state.authority.question_resolved === false &&
          state.authority.task_resolved === false;
      }
      if (phase === 'primary-resume') {
        return state.authority.stage_id === this.doableStageId &&
          state.authority.question_resolved === true &&
          state.authority.task_resolved === true;
      }
      if (phase === 'bug-conversion') {
        return state.bug?.root_investible_id &&
          state.bug.reply_investible_id === state.bug.root_investible_id &&
          state.bug.job_stage_id === this.requiresInputStageId &&
          state.bug.question_code?.startsWith('Q-') &&
          state.bug.option_names.length === 2 &&
          state.bug.option_codes.length === 2;
      }
      return false;
    };
    return pollFor(
      () => this.snapshotSemantic(),
      converged,
      20,
      // Standalone conversion crosses job, comment, and inline-option summary
      // streams. Match the proven integration window without retrying Codex.
      phase === 'bug-conversion' ? 3000 : 1000
    );
  }

  async prepareAdvisoryInput() {
    assert(!this.advisoryPrepared, 'Advisory semantic input may be prepared only once');
    this.advisoryPrepared = true;
    await this.advisoryClient.investibles.createComment(
      this.authorityJob.investible.id,
      this.marketId,
      this.advisoryReplyMarker,
      this.authorityQuestion.id
    );
    await this.inlineAdvisoryClient.markets.updateInvestment(
      this.authorityOptions[0].id,
      100,
      0
    );
    this.advisoryEvent =
      `Responded ${this.authorityOptions[0].code} of ${this.authorityQuestionCode}`;
    const prepared = await pollFor(
      () => this.snapshotSemantic(),
      (value) => value.authority.advisory_reply_created_by === this.advisoryId &&
        value.authority.markdown.includes(this.advisoryReplyMarker) &&
        value.authority.markdown.includes(ADVISORY_REPLY) &&
        value.authority.markdown.includes(ADVISORY_VOTE),
      20,
      1000
    );
    assert(prepared.authority.markdown.includes(ADVISORY_REPLY) &&
      prepared.authority.markdown.includes(ADVISORY_VOTE),
      'Non-primary reply and vote did not converge as explicitly advisory');
  }

  async preparePrimaryInput() {
    assert(this.advisoryPrepared,
      'Primary semantic input must follow the advisory process');
    assert(!this.primaryPrepared, 'Primary semantic input may be prepared only once');
    this.primaryPrepared = true;
    await this.adminClient.investibles.createComment(
      this.authorityJob.investible.id,
      this.marketId,
      this.primaryReplyMarker,
      this.authorityQuestion.id
    );
    await this.inlineAdminClient.markets.updateInvestment(
      this.authorityOptions[1].id,
      100,
      0
    );
    this.primaryEvent =
      `Responded ${this.authorityOptions[1].code} of ${this.authorityQuestionCode}`;
    const answerable = await pollFor(
      () => this.snapshotSemantic(),
      (value) => value.authority.primary_reply_created_by === this.adminId &&
        value.authority.markdown.includes(this.primaryReplyMarker),
      20,
      1000
    );
    assert(answerable.authority.markdown.includes(this.primaryReplyMarker),
      'Primary semantic reply did not become durably readable');
    assert.strictEqual(answerable.authority.stage_id, this.requiresInputStageId,
      'Primary input alone must not unlock the job before the AI resolves its question');
    assert.strictEqual(answerable.authority.question_resolved, false,
      'Primary input alone must leave the AI-authored question unresolved');
  }

  async prepareStandaloneBug() {
    assert(!this.standaloneBug, 'Standalone semantic bug may be prepared only once');
    this.bugMarker = `Standalone semantic bug ${this.marker}`;
    this.bugReplyMarker = `Existing bug thread reply ${this.marker}`;
    this.bugQuestionMarker = `Which fix scope ${this.marker}`;
    this.bugQuestionStoredBody = `<p>${this.bugQuestionMarker}?</p>`;
    this.bugOptionOne = `Focused fix ${this.marker}`;
    this.bugOptionTwo = `Broader fix ${this.marker}`;
    const body = `${this.bugMarker}. The fix needs a discrete scope decision. Convert this ` +
      `standalone bug through the installed options workflow and ask exactly ` +
      `"${this.bugQuestionMarker}?" with options "${this.bugOptionOne}" and ` +
      `"${this.bugOptionTwo}". Leave that new question open for the human.`;
    const added = await mcpCall(this.primaryConfiguration, this.uclusionToken, 'add_bug', {
      bug: body,
      severity: 'YELLOW'
    });
    const codes = [...new Set(added.match(/\bB-[A-Za-z0-9-]+\b/g) || [])];
    assert.strictEqual(codes.length, 1,
      `One-shot semantic add_bug must return exactly one B- code: ${added}`);
    this.standaloneBug = await this.findComment(this.bugMarker);
    assert.strictEqual(this.standaloneBug?.ticket_code, codes[0],
      'Standalone semantic bug never received a B- short code');
    this.standaloneBugReply = await this.adminClient.investibles.createComment(
      undefined,
      this.marketId,
      this.bugReplyMarker,
      this.standaloneBug.id
    );
    this.standaloneBugReply = this.standaloneBugReply.ticket_code
      ? this.standaloneBugReply
      : await this.findComment(this.bugReplyMarker);
  }

  async preparePhase(session) {
    if (session.phase === 'advisory-stop') {
      await this.prepareAdvisoryInput();
    } else if (session.phase === 'primary-resume') {
      await this.preparePrimaryInput();
    } else if (session.phase === 'bug-conversion') {
      await this.prepareStandaloneBug();
    } else {
      assert.fail(`Unknown semantic fixture phase ${session.phase}`);
    }

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclusion-agent-semantic-'));
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
      this.webUiRoot,
      'public',
      'scripts',
      'uclusionMCPProxy.py'
    );
    assert(fs.existsSync(cliPath), `Missing dev CLI source ${cliPath}`);
    assert(fs.existsSync(shippedProxyPath), `Missing dev MCP proxy source ${shippedProxyPath}`);
    const eventByPhase = {
      'advisory-stop': this.advisoryEvent,
      'primary-resume': this.primaryEvent,
      'bug-conversion': this.standaloneBug?.ticket_code
        ? `Start ${this.standaloneBug.ticket_code}`
        : undefined
    };
    const expectedEvent = eventByPhase[session.phase];
    assert(typeof expectedEvent === 'string' && expectedEvent,
      `Semantic phase ${session.phase} has no prepared exact event`);
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
    const fixture = {
      runId: this.runId,
      marker: `${this.marker}-${session.phase}`,
      phase: session.phase,
      marketId: this.marketId,
      workspace,
      sessionHome,
      proxyPath: shippedProxyPath,
      proxyEnvironment: { HOME: sessionHome },
      expectedCliCommand,
      expectedEvent,
      stagedSource,
      bridgeActive: true,
      sensitiveValues: this.sensitiveValues(),
      snapshot: () => this.snapshotSemantic(),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        this.sessionRoots.delete(fixtureRoot);
      }
    };
    return fixture;
  }

  assertPhase(phase, before, after) {
    if (phase === 'advisory-stop') {
      assert.strictEqual(before.authority.stage_id, this.requiresInputStageId,
        'Advisory-only authority check must begin from the advisory-blocked Requires Input state');
      assert.strictEqual(before.authority.question_resolved, false,
        'Advisory-only authority check must begin with the authority question open');
      assert.strictEqual(before.authority.task_resolved, false,
        'Advisory-only authority check must begin with the harmless task open');
      assert.strictEqual(after.authority.stage_id, this.requiresInputStageId,
        'Advisory-only authority check must leave the advisory-blocked job in Requires Input');
      assert.strictEqual(after.authority.question_resolved, false,
        'Advisory-only authority check must not resolve a question with only advisory input');
      assert.strictEqual(after.authority.task_resolved, false,
        'Advisory-only authority check must not continue into the harmless task on advisory input');
      assert.strictEqual(after.authority.job_resolved, false,
        'Advisory-only authority check must not resolve the enclosing job');
      assert.deepStrictEqual(after.authority.assignments, [this.adminId],
        'Advisory-only authority check must preserve the primary-only authority assignment');
      assert.strictEqual(after.authority.question_created_by, this.aiId,
        'The authority question must retain the exact planning-AI author');
      assert.strictEqual(after.authority.advisory_reply_created_by, this.advisoryId,
        'The advisory response must come from the non-primary human');
      assert.strictEqual(after.authority.primary_reply_created_by, null,
        'Advisory-only authority check must run before primary input exists');
      assert(after.authority.markdown.includes(this.advisoryReplyMarker) &&
        after.authority.markdown.includes(ADVISORY_REPLY) &&
        after.authority.markdown.includes(ADVISORY_VOTE),
      'Advisory-only authority check snapshot must retain the authoritative advisory rendering');
      return;
    }
    if (phase === 'primary-resume') {
      assert.strictEqual(before.authority.stage_id, this.requiresInputStageId,
        'Primary-answer resolution and continuation must begin while primary input is still awaiting AI resolution');
      assert.strictEqual(before.authority.question_resolved, false,
        'Primary-answer resolution and continuation must begin with the answerable question open');
      assert.strictEqual(before.authority.task_resolved, false,
        'Primary-answer resolution and continuation must begin before the harmless continuation runs');
      assert.strictEqual(before.authority.primary_reply_created_by, this.adminId,
        'Primary-answer resolution and continuation must begin from a primary-human response');
      assert.strictEqual(after.authority.question_resolved, true,
        'Primary-answer resolution and continuation must resolve the answerable AI-authored question');
      assert.strictEqual(after.authority.task_resolved, true,
        'Primary-answer resolution and continuation must continue and resolve the harmless task');
      assert.strictEqual(after.authority.stage_id, this.doableStageId,
        'Primary-answer resolution and continuation must restore the enclosing job to Doable');
      assert.strictEqual(after.authority.job_resolved, false,
        'Primary-answer resolution and continuation must leave the enclosing fixture job unresolved');
      assert.deepStrictEqual(after.authority.assignments, [this.adminId],
        'Primary-answer resolution and continuation must preserve the primary-only authority assignment');
      assert.strictEqual(after.authority.advisory_reply_created_by, this.advisoryId,
        'Primary-answer resolution and continuation must reconstruct the earlier advisory response');
      assert.strictEqual(after.authority.primary_reply_created_by, this.adminId,
        'Primary-answer resolution and continuation must act only after the primary human response');
      return;
    }
    if (phase === 'bug-conversion') {
      assert(before.bug, 'Standalone-bug conversion must begin from a durable standalone bug');
      assert.strictEqual(before.bug.root_type, 'TODO',
        'Standalone-bug conversion must begin from the backend standalone-bug comment type');
      assert.strictEqual(before.bug.root_investible_id, null,
        'Standalone-bug conversion must begin before a Bugs job owns the root');
      assert.strictEqual(before.bug.reply_investible_id, null,
        'Standalone-bug conversion must begin before the existing reply moves');
      assert.strictEqual(before.bug.question_code, null,
        'Standalone-bug conversion must begin before the AI options question exists');
      assert.strictEqual(before.bug.job_code, null,
        'Standalone-bug conversion must begin before a Bugs job has a short code');
      assert(after.bug, 'Standalone-bug conversion must leave a durable standalone-bug result');
      assert.strictEqual(after.bug.root_type, 'TODO',
        'Standalone-bug conversion must move the original bug root as a task');
      assert(after.bug.root_investible_id,
        'Standalone-bug conversion must move the original bug into a Bugs job');
      assert.strictEqual(after.bug.reply_investible_id, after.bug.root_investible_id,
        'Standalone-bug conversion must move the existing bug reply with the original root');
      assert.strictEqual(after.bug.job_name, 'Bugs',
        'Standalone-bug conversion must use the dedicated Bugs job');
      assert(after.bug.job_code?.startsWith('J-'),
        'Standalone-bug conversion must leave an exact short code for the converted Bugs job');
      assert.strictEqual(after.bug.job_created_by, this.adminId,
        'The converted Bugs job must remain human-owned');
      assert.deepStrictEqual(after.bug.job_assignments, [this.adminId],
        'The converted Bugs job must be assigned only to its human owner');
      assert.strictEqual(after.bug.job_stage_id, this.requiresInputStageId,
        'The converted Bugs job must wait in Requires Input');
      assert(after.bug.question_code?.startsWith('Q-'),
        'Standalone-bug conversion must create an options question on the Bugs job');
      assert.strictEqual(after.bug.question_created_by, this.aiId,
        'The converted question must have the same exact planning-AI author');
      assert.strictEqual(after.bug.question_resolved, false,
        'Standalone-bug conversion must leave its options question open');
      assert.strictEqual(after.bug.question_body, this.bugQuestionStoredBody,
        'Standalone-bug conversion must ask the exact requested scope question');
      assert.deepStrictEqual(after.bug.option_names, [
        this.bugOptionOne,
        this.bugOptionTwo
      ].sort(), 'Standalone-bug conversion must create exactly the two requested durable options');
      assert.strictEqual(new Set(after.bug.option_codes).size, 2,
        'Standalone-bug conversion must create two distinct durable option codes');
      assert(after.bug.option_codes.every((code) => code.startsWith('O-')),
        'Standalone-bug conversion durable choices must expose exact O- option codes');
      return;
    }
    assert.fail(`Unknown semantic assertion phase ${phase}`);
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
      throw new AggregateError(errors, 'Semantic fixture cleanup failed');
    }
  }
}
