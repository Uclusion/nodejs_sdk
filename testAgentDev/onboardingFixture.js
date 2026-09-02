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
  parseAdvisoryDevCredentials,
  pollMcp,
  seedCodexAuth,
  writeSessionState
} from './semanticFixture.js';
import {
  ONBOARDING_COLLABORATOR_EMAIL,
  ONBOARDING_VIEW_NAME
} from './onboardingScenarios.js';
import { stageSourcePackage } from './sourcePackage.js';

const Amplify = awsAmplify.default;

// T-all-2472 live onboarding: one wizard-fresh market whose only durable
// mutation should be the view the agent creates from the served guidance.
export class OnboardingDevFixture {
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
    this.configuration = { ...DEV_ENDPOINTS,
      username: primary.username, password: primary.password };
    this.configuration.idToken = await loginUserToIdentity(this.configuration);
    this.registerSensitiveValues([this.configuration.idToken]);
    // S-all-244: the live scenario adds this identity by email. Market
    // membership is proven by the capability count alone because same-account
    // logins prove nothing and could create the capability under test; the
    // fixture logs in as the identity only after the count already rose, and
    // only to learn its user id for the id-addressed group membership read.
    // The username is checked-in public data that appears in the prompt, so
    // it must not be registered for redaction.
    const advisory = parseAdvisoryDevCredentials(this.env);
    assert.strictEqual(advisory.username.toLowerCase(),
      ONBOARDING_COLLABORATOR_EMAIL.toLowerCase(),
      'Onboarding collaborator email must match the advisory identity the prompt names');
    this.registerSensitiveValues([advisory.raw, advisory.password]);
    this.advisoryConfiguration = { ...DEV_ENDPOINTS,
      username: advisory.username, password: advisory.password };
    const accountLogin = await loginUserToAccountAndGetToken(this.configuration);
    this.accountClient = accountLogin.client;
    this.accountToken = accountLogin.accountToken;
    this.registerSensitiveValues([this.accountToken]);
    const marker = `${this.runId.slice(0, 8)}-${randomUUID().slice(0, 12)}`;
    this.marker = marker;
    const marketResult = await this.accountClient.markets.createMarket({
      name: `Agent onboarding ${marker}`,
      market_type: 'PLANNING'
    });
    this.marketId = marketResult?.market?.id;
    assert(this.marketId, 'Onboarding market creation omitted the exact market id');
    this.registerMarket(this.marketId);
    assert.strictEqual(marketResult.market.market_sub_type, INTEGRATION_TEST_SUB_TYPE,
      'Onboarding market was not marked for guarded integration-test deletion');
    this.registerSensitiveValues([marketResult.market.invite_capability]);
    await loginUserToMarketInvite(this.configuration, marketResult.market.invite_capability);
    const marketLogin = await loginUserToMarketAndGetToken(this.configuration, this.marketId);
    this.adminClient = marketLogin.client;
    this.adminId = (await this.adminClient.users.get()).id;
    this.registerSensitiveValues([marketLogin.marketToken]);
    this.uclusionToken = await mcpLogin(this.configuration, this.adminClient, this.marketId);
    this.registerSensitiveValues([this.uclusionToken]);
    // The AI user materializes asynchronously; this readiness probe may also
    // consume the one-time setup guidance marker, so the reset below must
    // stay after it and no later fixture code may call find_work again.
    await pollMcp(this.configuration, this.uclusionToken, 'find_work', {});
    const user = await this.accountClient.users.get();
    const priorPreferences = user.ui_preferences ? JSON.parse(user.ui_preferences) : {};
    delete priorPreferences.aiViewSetupGuidanceShown;
    await this.accountClient.users.update({ uiPreferences: JSON.stringify(priorPreferences) });
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
        // The one joined human plus the planning AI must both hold market
        // capabilities before the live process writes.
        return (capabilities?.object_versions || []).length >= 2;
      },
      20,
      500
    );
    const readyCapabilities = canonicalMarketSignature(capabilityReadyVersions, this.marketId)
      .find((signature) => signature.type === 'market_capability');
    assert((readyCapabilities?.object_versions || []).length >= 2,
      'Onboarding market AI capability did not converge before the live process');
    const ready = await this.snapshotSemantic();
    assert(!ready.group_names.includes(ONBOARDING_VIEW_NAME),
      `Onboarding market unexpectedly already has a ${ONBOARDING_VIEW_NAME} view`);
    assert.strictEqual(ready.capability_count, 2,
      'Onboarding market must start with only the primary human and the planning AI');
  }

  targets() {
    return {};
  }

  async snapshotSemantic() {
    const versions = await this.accountClient.summaries.versions(
      this.accountToken,
      [this.marketId]
    );
    const groupSignature = canonicalMarketSignature(versions, this.marketId)
      .find((signature) => signature.type === 'group');
    const references = (groupSignature?.object_versions || []).map((version) => ({
      id: version.object_id_one,
      version: version.version
    }));
    const groups = references.length
      ? await this.adminClient.markets.listGroups(references)
      : [];
    const capabilities = canonicalMarketSignature(versions, this.marketId)
      .find((signature) => signature.type === 'market_capability');
    const capabilityCount = (capabilities?.object_versions || []).length;
    // The market is hermetic: the third capability can only come from the
    // graded add_collaborators call, and only its view placement can put the
    // advisory identity in the Engineering view. The group membership read is
    // id-addressed, so it needs the advisory user id, learned by a login that
    // happens strictly after the capability count already rose.
    let advisoryPlaced = false;
    const engineering = groups.find((group) => group.name === ONBOARDING_VIEW_NAME);
    if (engineering && capabilityCount >= 3) {
      if (!this.advisoryUserId) {
        this.advisoryConfiguration.idToken = this.advisoryConfiguration.idToken ||
          await loginUserToIdentity(this.advisoryConfiguration);
        this.registerSensitiveValues([this.advisoryConfiguration.idToken]);
        const advisoryLogin = await loginUserToMarketAndGetToken(
          this.advisoryConfiguration,
          this.marketId
        );
        this.registerSensitiveValues([advisoryLogin.marketToken]);
        this.advisoryUserId = (await advisoryLogin.client.users.get()).id;
      }
      const members = await this.adminClient.markets.listGroupMembers(
        engineering.id,
        [{ id: this.advisoryUserId, version: 1 }]
      );
      advisoryPlaced = members.some((member) =>
        member.id === this.advisoryUserId && !member.deleted);
    }
    return {
      market_id: this.marketId,
      group_names: groups.map((group) => group.name).sort(),
      capability_count: capabilityCount,
      advisory_placed: advisoryPlaced
    };
  }

  async snapshotAfterPhase(phase) {
    assert.strictEqual(phase, 'onboarding', `Unknown onboarding fixture phase ${phase}`);
    return pollFor(
      () => this.snapshotSemantic(),
      (state) => state.group_names.includes(ONBOARDING_VIEW_NAME) &&
        state.capability_count >= 3 && state.advisory_placed,
      20,
      3000
    );
  }

  assertPhase(phase, before, after) {
    assert.strictEqual(phase, 'onboarding', `Unknown onboarding assertion phase ${phase}`);
    assert(!before.group_names.includes(ONBOARDING_VIEW_NAME),
      'Live onboarding must begin before the requested view exists');
    assert.strictEqual(before.capability_count, 2,
      'Live onboarding must begin with only the primary human and the planning AI');
    assert(after.group_names.includes(ONBOARDING_VIEW_NAME),
      `Live onboarding must durably create the ${ONBOARDING_VIEW_NAME} view`);
    assert(after.capability_count >= 3,
      'Live onboarding must durably add the collaborator to the workspace by email');
    assert(after.advisory_placed,
      `Live onboarding must durably place the collaborator in the ${ONBOARDING_VIEW_NAME} view`);
  }

  async preparePhase(session) {
    assert.strictEqual(session.phase, 'onboarding',
      `Unknown onboarding fixture phase ${session.phase}`);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uclusion-agent-onboarding-'));
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
      phase: session.phase,
      marketId: this.marketId,
      workspace,
      sessionHome,
      proxyPath: shippedProxyPath,
      proxyEnvironment: { HOME: sessionHome },
      expectedCliCommand,
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
      throw new AggregateError(errors, 'Onboarding fixture cleanup failed');
    }
  }
}
