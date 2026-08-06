import assert from 'assert';
import { randomUUID } from 'crypto';
import AWS from 'aws-sdk';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

const REGION = 'us-west-2';
const INTEGRATION_TEST_SUB_TYPE = 'INTEGRATION_TEST';
const LAMBDA_HTTP_TIMEOUT_MS = 210000;
const DELETE_FUNCTION_BY_BASE_URL = new Map([
  ['https://dev.api.uclusion.com/v1', 'uclusion-markets-dev-markets_delete'],
  ['https://stage.api.uclusion.com/v1', 'uclusion-markets-stage-markets_delete']
]);

function machineCapability(marketId) {
  return {
    role: 'Machine',
    is_admin: true,
    type: 'market',
    id: marketId
  };
}

function decodeLambdaPayload(response, functionName) {
  assert.strictEqual(
    response.StatusCode,
    200,
    `${functionName} invocation failed with status ${response.StatusCode}`
  );
  const payloadText = Buffer.from(response.Payload || '').toString('utf8');
  let envelope;
  try {
    envelope = JSON.parse(payloadText);
  } catch (error) {
    assert.fail(`${functionName} returned invalid JSON: ${payloadText}`);
  }
  if (response.FunctionError || envelope.errorMessage) {
    assert.fail(
      `${functionName} failed: ${response.FunctionError || envelope.errorMessage}`
    );
  }
  let body = envelope.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      // Preserve a non-JSON error body for the assertion below.
    }
  }
  return { statusCode: envelope.statusCode, body };
}

async function deleteIntegrationTestMarket(adminConfiguration, marketId) {
  const functionName = DELETE_FUNCTION_BY_BASE_URL.get(adminConfiguration.baseURL);
  assert(
    functionName,
    `Refusing audit fixture deletion in unsupported environment ${adminConfiguration.baseURL}`
  );
  const lambda = new AWS.Lambda({
    region: REGION,
    maxRetries: 0,
    httpOptions: { timeout: LAMBDA_HTTP_TIMEOUT_MS }
  });
  const response = await lambda.invoke({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ capability: machineCapability(marketId) })
  }).promise();
  const result = decodeLambdaPayload(response, functionName);
  assert.strictEqual(
    result.statusCode,
    200,
    `Cleanup delete failed for ${marketId}: ${JSON.stringify(result.body)}`
  );
  assert(
    ['Market deleted', 'Market already deleted'].includes(result.body?.success_message),
    `Unexpected cleanup response for ${marketId}: ${JSON.stringify(result.body)}`
  );
}

export default function (adminConfiguration) {
  describe('#test MCP job token audits (J-all-387)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
    let uclusionToken;

    before(async function () {
      this.timeout(300000);
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      accountToken = accountLogin.accountToken;
      const result = await accountClient.markets.createMarket({
        name: 'MCP job token audit integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      assert.strictEqual(
        result.market.market_sub_type,
        INTEGRATION_TEST_SUB_TYPE,
        'Audit fixture was not marked for guarded deletion'
      );
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
    });

    after(async function () {
      this.timeout(300000);
      if (marketId) {
        // A hook keeps cleanup independent of the test result, so a failed
        // assertion remains visible even if guarded fixture deletion also fails.
        await deleteIntegrationTestMarket(adminConfiguration, marketId);
      }
    });

    async function pollFor(fetcher, isDone) {
      let result = await fetcher();
      for (let i = 0; i < 20 && !isDone(result); i += 1) {
        await sleep(3000);
        result = await fetcher();
      }
      return result;
    }

    async function pollMcp(toolName, args) {
      for (let i = 0; i < 10; i += 1) {
        try {
          return await mcpCall(adminConfiguration, uclusionToken, toolName, args);
        } catch (error) {
          await sleep(3000);
        }
      }
      return mcpCall(adminConfiguration, uclusionToken, toolName, args);
    }

    function parseMcpToolResult(stringifiedEnvelope) {
      const toolResult = JSON.parse(stringifiedEnvelope).result;
      return toolResult.structuredContent || JSON.parse(toolResult.content[0].text);
    }

    async function getTicketCode(investible) {
      const marketInfo = investible.market_infos[0];
      if (marketInfo.ticket_code) {
        return marketInfo.ticket_code;
      }
      const fetched = await pollFor(async () => {
        const current = await adminClient.markets.getMarketInvestibles([{
          investible: { id: investible.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        return current?.[0]?.market_infos?.[0]?.ticket_code;
      }, (ticketCode) => ticketCode);
      assert(fetched, `Ticket code missing for ${investible.investible.id}`);
      return fetched;
    }

    async function listMarketComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === marketId);
      const commentVersions = new Map();
      (marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const currentVersion = commentVersions.get(version.object_id_one) || 0;
          commentVersions.set(version.object_id_one, Math.max(currentVersion, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return adminClient.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    function finalization(total, phaseTotals, startedAt) {
      return {
        schema_version: 1,
        source: {
          provider: 'openai',
          client: 'codex',
          client_version: '0.146.0',
          model: 'gpt-5.6-sol',
          effort: 'high',
          source_mode: 'native',
          session_fingerprint: '0123456789abcdef'
        },
        window: {
          started_at: startedAt,
          ended_at: '2026-08-05T10:02:00Z',
          elapsed_ms: 120000
        },
        measurement: {
          status: 'exact',
          normalized_total_tokens: total,
          normalization: 'openai_input_includes_cache_v1',
          raw_counts: [
            { field: 'fresh_input_tokens', value: total - 40, semantics: 'fresh_input' },
            { field: 'cached_input_tokens', value: 10, semantics: 'cached_input_subset' },
            { field: 'output_tokens', value: 30, semantics: 'generated_output' }
          ]
        },
        phases: {
          method: 'next_request_marker_v1',
          ...phaseTotals
        },
        activity: {
          model_requests: 4,
          tool_calls: 8,
          tool_failures: 1,
          test_commands: 2
        },
        coverage: {
          main_session: 'complete',
          descendants: 'complete',
          descendants_discovered: 1,
          descendants_included: 1
        }
      };
    }

    it('canonicalizes child targets, persists one note per run, and accumulates totals', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Audited job ${marker}`,
        description: 'Job used to verify structured agent token usage notes.'
      });
      const jobTicketCode = await getTicketCode(job);
      const task = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        `Audited task ${marker}`,
        null,
        'TODO'
      );
      assert(task.ticket_code, `Task ticket code missing: ${JSON.stringify(task)}`);

      const firstRunId = randomUUID();
      const started = parseMcpToolResult(await pollMcp('start_job_audit', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId
      }));
      assert.strictEqual(started.state, 'active');
      assert.strictEqual(started.audit_run_id, firstRunId);
      assert.strictEqual(started.canonical_job_id, jobTicketCode);

      const marked = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        phase: 'testing',
        marker_sequence: 3
      }));
      assert.strictEqual(marked.state, 'marked');
      assert.strictEqual(marked.effective, 'next_model_request');
      assert.strictEqual(marked.marker_sequence, 3);
      assert.strictEqual(marked.canonical_job_id, jobTicketCode);

      const pending = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        handoff_type: 'review_requested'
      }));
      assert.strictEqual(pending.state, 'pending_finalization');

      const firstFinalization = finalization(160, {
        planning: 30,
        implementation: 80,
        testing: 40,
        other: 10
      }, '2026-08-05T10:00:00Z');
      const first = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        handoff_type: 'review_requested',
        finalization: firstFinalization
      }));
      assert.strictEqual(first.state, 'completed');
      assert.strictEqual(first.idempotent, false);
      assert.strictEqual(first.canonical_job_id, jobTicketCode);
      assert.strictEqual(first.run_normalized_total_tokens, 160);
      assert.strictEqual(first.cumulative.audited_runs, 1);
      assert.strictEqual(first.cumulative.measured_runs, 1);
      assert.strictEqual(first.cumulative.normalized_total_tokens, 160);
      assert(first.note_short_code_id.startsWith('R-'), JSON.stringify(first));

      const commentsAfterFirst = await pollFor(listMarketComments,
        (comments) => comments.some((comment) =>
          comment.job_audit?.audit_run_id === firstRunId));
      const firstNote = commentsAfterFirst.find((comment) =>
        comment.job_audit?.audit_run_id === firstRunId);
      assert(firstNote, `Structured audit note missing: ${JSON.stringify(commentsAfterFirst)}`);
      assert.strictEqual(firstNote.investible_id, job.investible.id);
      assert.strictEqual(firstNote.comment_type, 'REPORT');
      assert.strictEqual(firstNote.notification_type, 'BLUE');
      assert.strictEqual(firstNote.job_audit.schema_version, 1);
      assert.strictEqual(firstNote.job_audit.canonical_job_id, jobTicketCode);
      assert.strictEqual(firstNote.job_audit.handoff_type, 'review_requested');
      assert.deepStrictEqual(firstNote.job_audit.run, firstFinalization);
      assert(firstNote.body.includes('### Agent token usage'), firstNote.body);
      assert(firstNote.body.includes(firstRunId), firstNote.body);

      const jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', {
          short_code_id: jobTicketCode,
          include_all_resolved: true
        }),
        (markdown) => markdown.includes(firstRunId)
      );
      assert(jobMarkdown.includes('Agent token usage'), jobMarkdown);
      assert(jobMarkdown.includes('160 normalized tokens'), jobMarkdown);

      const replay = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: jobTicketCode,
        audit_run_id: firstRunId,
        handoff_type: 'review_requested',
        finalization: firstFinalization
      }));
      assert.strictEqual(replay.state, 'completed');
      assert.strictEqual(replay.idempotent, true);
      assert.strictEqual(replay.note_short_code_id, first.note_short_code_id);
      assert.strictEqual(replay.cumulative.audited_runs, 1);
      assert.strictEqual(replay.cumulative.normalized_total_tokens, 160);

      const secondRunId = randomUUID();
      const secondFinalization = finalization(40, {
        planning: 5,
        implementation: 20,
        testing: 10,
        other: 5
      }, '2026-08-05T10:01:00Z');
      const second = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: jobTicketCode,
        audit_run_id: secondRunId,
        handoff_type: 'progress',
        finalization: secondFinalization
      }));
      assert.strictEqual(second.state, 'completed');
      assert.strictEqual(second.cumulative.audited_runs, 2);
      assert.strictEqual(second.cumulative.measured_runs, 2);
      assert.strictEqual(second.cumulative.exact_runs, 2);
      assert.strictEqual(second.cumulative.normalized_total_tokens, 200);
      assert.strictEqual(second.cumulative.planning, 35);
      assert.strictEqual(second.cumulative.implementation, 100);
      assert.strictEqual(second.cumulative.testing, 50);
      assert.strictEqual(second.cumulative.other, 15);

      const commentsAfterSecond = await pollFor(listMarketComments,
        (comments) => comments.filter((comment) =>
          [firstRunId, secondRunId].includes(comment.job_audit?.audit_run_id)).length === 2);
      const auditNotes = commentsAfterSecond.filter((comment) =>
        [firstRunId, secondRunId].includes(comment.job_audit?.audit_run_id));
      assert.strictEqual(auditNotes.length, 2,
        `Each audit run should persist exactly one note: ${JSON.stringify(auditNotes)}`);
      const secondNote = auditNotes.find((comment) =>
        comment.job_audit.audit_run_id === secondRunId);
      assert.strictEqual(secondNote.job_audit.cumulative.normalized_total_tokens, 200);
    }).timeout(600000);
  });
}
