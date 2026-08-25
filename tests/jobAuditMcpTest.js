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
export const INTEGRATION_TEST_SUB_TYPE = 'INTEGRATION_TEST';
const LAMBDA_HTTP_TIMEOUT_MS = 210000;
// Both AWS accounts deploy the serverless stack named "dev"; environments
// differ by account credentials, so the function name is the same on stage.
const DELETE_FUNCTION_BY_BASE_URL = new Map([
  ['https://dev.api.uclusion.com/v1', 'uclusion-markets-dev-markets_delete'],
  ['https://stage.api.uclusion.com/v1', 'uclusion-markets-dev-markets_delete']
]);
const EXPORT_FUNCTION_BY_BASE_URL = new Map([
  ['https://dev.api.uclusion.com/v1', 'uclusion-markets-dev-markets_export'],
  ['https://stage.api.uclusion.com/v1', 'uclusion-markets-dev-markets_export']
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

export async function deleteIntegrationTestMarket(adminConfiguration, marketId) {
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

    async function listHumanCommentVersionIds() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === marketId);
      return new Set((marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .map((version) => version.object_id_one));
    }

    async function listRawMarketComments(marketInvestibleId) {
      const functionName = EXPORT_FUNCTION_BY_BASE_URL.get(adminConfiguration.baseURL);
      assert(
        functionName,
        `Refusing raw audit export in unsupported environment ${adminConfiguration.baseURL}`
      );
      const lambda = new AWS.Lambda({
        region: REGION,
        maxRetries: 2,
        httpOptions: { timeout: LAMBDA_HTTP_TIMEOUT_MS }
      });
      const response = await lambda.invoke({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        ClientContext: Buffer.from(JSON.stringify({
          custom: { capability: machineCapability(marketId) }
        })).toString('base64'),
        Payload: JSON.stringify({ market_investible_ids: [marketInvestibleId] })
      }).promise();
      const result = decodeLambdaPayload(response, functionName);
      assert.strictEqual(
        result.statusCode,
        200,
        `Raw audit export failed for ${marketId}: ${JSON.stringify(result.body)}`
      );
      assert.strictEqual(result.body?.jobs?.length, 1,
        `Raw audit export did not return one job: ${JSON.stringify(result.body)}`);
      const exportedJob = result.body.jobs[0];
      return [...(exportedJob.comments || []), ...(exportedJob.resolved_comments || [])]
        .map(({ comment }) => comment);
    }

    function assertMachineOnlyAuditNote(comment) {
      assert.strictEqual(comment.is_machine_only, true,
        `Audit note must be machine-only: ${JSON.stringify(comment)}`);
      assert.strictEqual(comment.is_visible, false,
        `Audit note must stay out of ordinary get_job: ${JSON.stringify(comment)}`);
    }

    function finalization(total, bucketItems, startedAt, overrides = {}) {
      const status = overrides.status || 'exact';
      const outputTokens = Math.min(30, total);
      const cachedInputTokens = Math.min(10, total - outputTokens);
      const freshInputTokens = total - outputTokens - cachedInputTokens;
      const measurement = {
        status,
        normalized_total_tokens: total,
        normalization: 'openai_input_includes_cache_v1',
        raw_counts: [
          { field: 'fresh_input_tokens', value: freshInputTokens, semantics: 'fresh_input' },
          { field: 'cached_input_tokens', value: cachedInputTokens, semantics: 'cached_input_subset' },
          { field: 'output_tokens', value: outputTokens, semantics: 'generated_output' }
        ]
      };
      if (overrides.reasonCode) {
        measurement.reason_code = overrides.reasonCode;
      }
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
        measurement,
        buckets: {
          method: 'next_request_marker_v1',
          items: bucketItems
        },
        activity: {
          model_requests: 4,
          tool_calls: 8,
          tool_failures: 1,
          test_commands: 2
        },
        coverage: {
          main_session: overrides.mainSession || 'complete',
          descendants: overrides.descendants || 'complete',
          descendants_discovered: 1,
          descendants_included: 1
        }
      };
    }

    it('publishes ordered bucket checkpoints before the terminal audit note', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Audited job ${marker}`,
        description: 'Job used to verify ordinary export-readable agent token usage notes.'
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
      const listRawJobComments = () => listRawMarketComments(job.market_infos[0].id);

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
        bucket: 'web searches',
        marker_sequence: 1
      }));
      assert.strictEqual(marked.state, 'marked');
      assert.strictEqual(marked.effective, 'next_model_request');
      assert.strictEqual(marked.bucket, 'web searches');
      assert.strictEqual(marked.marker_sequence, 1);
      assert.strictEqual(marked.canonical_job_id, jobTicketCode);

      const firstCheckpointFinalization = finalization(30, [
        { label: 'planning', tokens: 30 }
      ], '2026-08-05T10:00:00Z');
      const firstCheckpoint = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        bucket: 'web searches',
        marker_sequence: 1,
        finalization: firstCheckpointFinalization
      }));
      assert.strictEqual(firstCheckpoint.state, 'checkpointed');
      assert.strictEqual(firstCheckpoint.publication, 'checkpoint');
      assert.strictEqual(firstCheckpoint.idempotent, false);
      assert.strictEqual(firstCheckpoint.superseded, false);
      assert.strictEqual(firstCheckpoint.identity_verified, true);
      assert.match(firstCheckpoint.checkpoint_identity_fingerprint,
        /^sha256-v1:[0-9a-f]{64}$/);
      assert.strictEqual(firstCheckpoint.marker_sequence, 1);
      assert.strictEqual(firstCheckpoint.bucket, 'web searches');
      assert.strictEqual(firstCheckpoint.checkpoint_normalized_total_tokens, 30);

      const commentsAfterFirstCheckpoint = await pollFor(listRawJobComments,
        (comments) => comments.some((comment) =>
          comment.body?.includes(firstRunId)
          && comment.body?.includes('checkpoint:1')));
      const firstCheckpointNote = commentsAfterFirstCheckpoint.find((comment) =>
        comment.body?.includes(firstRunId) && comment.body?.includes('checkpoint:1'));
      assert(firstCheckpointNote,
        `First audit checkpoint missing before end: ${JSON.stringify(commentsAfterFirstCheckpoint)}`);
      assertMachineOnlyAuditNote(firstCheckpointNote);
      assert(firstCheckpointNote.body.includes('Closed-bucket snapshot'), firstCheckpointNote.body);
      assert(firstCheckpointNote.body.includes('planning'), firstCheckpointNote.body);
      assert(firstCheckpointNote.body.includes('Current bucket: web searches'),
        firstCheckpointNote.body);
      assert(firstCheckpointNote.body.includes('Audit checkpoint run:'),
        firstCheckpointNote.body);
      assert(firstCheckpointNote.body.includes(
        `Audit checkpoint identity: <code>${firstCheckpoint.checkpoint_identity_fingerprint}</code>`),
        firstCheckpointNote.body);

      const firstCheckpointReplay = parseMcpToolResult(await pollMcp(
        'set_job_audit_phase', {
          job_id: task.ticket_code,
          audit_run_id: firstRunId,
          bucket: 'web searches',
          marker_sequence: 1,
          finalization: firstCheckpointFinalization
        }));
      assert.strictEqual(firstCheckpointReplay.idempotent, true);
      assert.strictEqual(firstCheckpointReplay.superseded, false);
      assert.strictEqual(firstCheckpointReplay.identity_verified, true);
      assert.strictEqual(firstCheckpointReplay.checkpoint_identity_fingerprint,
        firstCheckpoint.checkpoint_identity_fingerprint);
      assert.strictEqual(firstCheckpointReplay.note_short_code_id,
        firstCheckpoint.note_short_code_id);

      const testingMarker = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        bucket: 'testing',
        marker_sequence: 2
      }));
      assert.strictEqual(testingMarker.state, 'marked');
      assert.strictEqual(testingMarker.marker_sequence, 2);

      const secondCheckpointFinalization = finalization(120, [
        { label: 'planning', tokens: 30 },
        { label: 'web searches', tokens: 90 }
      ], '2026-08-05T10:00:00Z');
      const secondCheckpoint = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        bucket: 'testing',
        marker_sequence: 2,
        finalization: secondCheckpointFinalization
      }));
      assert.strictEqual(secondCheckpoint.state, 'checkpointed');
      assert.strictEqual(secondCheckpoint.publication, 'checkpoint');
      assert.strictEqual(secondCheckpoint.idempotent, false);
      assert.strictEqual(secondCheckpoint.superseded, false);
      assert.strictEqual(secondCheckpoint.identity_verified, true);
      assert.match(secondCheckpoint.checkpoint_identity_fingerprint,
        /^sha256-v1:[0-9a-f]{64}$/);
      assert.strictEqual(secondCheckpoint.checkpoint_normalized_total_tokens, 120);

      const commentsAfterSecondCheckpoint = await pollFor(listRawJobComments,
        (comments) => comments.some((comment) =>
          comment.body?.includes(firstRunId)
          && comment.body?.includes('checkpoint:2')));
      const secondCheckpointNote = commentsAfterSecondCheckpoint.find((comment) =>
        comment.body?.includes(firstRunId) && comment.body?.includes('checkpoint:2'));
      assert(secondCheckpointNote,
        `Second audit checkpoint missing before end: ${JSON.stringify(commentsAfterSecondCheckpoint)}`);
      assertMachineOnlyAuditNote(secondCheckpointNote);
      assert(secondCheckpointNote.body.includes('planning'), secondCheckpointNote.body);
      assert(secondCheckpointNote.body.includes('web searches'), secondCheckpointNote.body);
      assert(secondCheckpointNote.body.includes('Current bucket: testing'),
        secondCheckpointNote.body);

      const staleCheckpoint = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        bucket: 'web searches',
        marker_sequence: 1,
        finalization: firstCheckpointFinalization
      }));
      assert.strictEqual(staleCheckpoint.state, 'checkpointed');
      assert.strictEqual(staleCheckpoint.publication, 'checkpoint');
      assert.strictEqual(staleCheckpoint.idempotent, false);
      assert.strictEqual(staleCheckpoint.superseded, true);
      assert.strictEqual(staleCheckpoint.identity_verified, false);
      assert.strictEqual(staleCheckpoint.note_short_code_id,
        secondCheckpoint.note_short_code_id);

      const pending = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        handoff_type: 'review_requested'
      }));
      assert.strictEqual(pending.state, 'pending_finalization');

      const firstFinalization = finalization(160, [
        { label: 'planning', tokens: 30 },
        { label: 'web searches', tokens: 90 },
        { label: 'testing', tokens: 40 }
      ], '2026-08-05T10:00:00Z');
      const first = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: task.ticket_code,
        audit_run_id: firstRunId,
        handoff_type: 'review_requested',
        finalization: firstFinalization
      }));
      assert.strictEqual(first.state, 'completed');
      assert.strictEqual(first.publication, 'final');
      assert.strictEqual(first.idempotent, false);
      assert.strictEqual(first.canonical_job_id, jobTicketCode);
      assert.strictEqual(first.run_normalized_total_tokens, 160);
      assert.strictEqual(first.cumulative, undefined);
      assert(first.note_short_code_id.startsWith('R-'), JSON.stringify(first));

      const commentsAfterFirst = await pollFor(listRawJobComments,
        (comments) => comments.some((comment) =>
          comment.body?.includes(firstRunId)
          && comment.body?.includes('Audit publication: <code>final</code>')));
      const firstNote = commentsAfterFirst.find((comment) =>
        comment.body?.includes(firstRunId)
        && comment.body?.includes('Audit publication: <code>final</code>'));
      assert(firstNote, `Export-readable audit note missing: ${JSON.stringify(commentsAfterFirst)}`);
      assert.strictEqual(firstNote.investible_id, job.investible.id);
      assert.strictEqual(firstNote.comment_type, 'REPORT');
      assert.strictEqual(firstNote.notification_type, 'BLUE');
      assert.strictEqual(firstNote.job_audit, undefined);
      assertMachineOnlyAuditNote(firstNote);
      assert(firstNote.body.includes('Agent token usage'), firstNote.body);
      assert(firstNote.body.includes(firstRunId), firstNote.body);
      assert(firstNote.body.includes('web searches'), firstNote.body);
      assert(firstNote.body.includes('90'), firstNote.body);
      assert(firstNote.body.includes('Source: codex'), firstNote.body);
      assert(firstNote.body.includes('Coverage: main complete'), firstNote.body);
      assert(firstNote.body.includes('Audit publication: <code>final</code>'),
        firstNote.body);

      const syncBarrierMarker = `Post-audit sync barrier ${marker}`;
      const syncBarrier = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        syncBarrierMarker,
        null,
        'TODO'
      );
      let humanCommentVersionIds = await pollFor(
        listHumanCommentVersionIds,
        (commentIds) => commentIds.has(syncBarrier.id)
      );
      assert(humanCommentVersionIds.has(syncBarrier.id),
        `Post-audit task did not reach ObjectVersions: ${JSON.stringify([...humanCommentVersionIds])}`);
      const firstRunAuditComments = commentsAfterFirst
        .filter((comment) => comment.body?.includes(firstRunId));
      const firstRunAuditIds = new Set(firstRunAuditComments.map((comment) => comment.id));
      for (let i = 0; i < 5; i += 1) {
        await sleep(3000);
        humanCommentVersionIds = await listHumanCommentVersionIds();
        assert(![...firstRunAuditIds].some((commentId) => humanCommentVersionIds.has(commentId)),
          `Machine-only audit notes reached ObjectVersions: ${JSON.stringify([...humanCommentVersionIds])}`);
      }
      const directlyHydratedAuditComments = await adminClient.investibles.getMarketComments(
        firstRunAuditComments.map((comment) => ({ id: comment.id, version: comment.version }))
      );
      assert(!directlyHydratedAuditComments.some((comment) => firstRunAuditIds.has(comment.id)),
        `Machine-only audit notes reached direct human hydration: ${JSON.stringify(directlyHydratedAuditComments)}`);

      const jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', {
          short_code_id: jobTicketCode
        }),
        (markdown) => markdown.includes(syncBarrierMarker)
      );
      assert(jobMarkdown.includes(syncBarrierMarker),
        'get_job did not reach the post-audit task barrier');
      assert(!jobMarkdown.includes(firstRunId),
        `Machine-only audit note reached ordinary get_job: ${jobMarkdown}`);

      const replay = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: jobTicketCode,
        audit_run_id: firstRunId,
        handoff_type: 'review_requested',
        finalization: firstFinalization
      }));
      assert.strictEqual(replay.state, 'completed');
      assert.strictEqual(replay.publication, 'final');
      assert.strictEqual(replay.idempotent, true);
      assert.strictEqual(replay.note_short_code_id, first.note_short_code_id);
      const auditNotes = (await listRawJobComments()).filter((comment) =>
        comment.body?.includes(firstRunId));
      const finalAuditNotes = auditNotes.filter((comment) =>
        comment.body?.includes('Audit publication: <code>final</code>'));
      assert.strictEqual(finalAuditNotes.length, 1,
        `Retry should preserve one final note for the run: ${JSON.stringify(auditNotes)}`);
      assert(auditNotes.length >= 3,
        `Run should retain its ordered checkpoints plus final: ${JSON.stringify(auditNotes)}`);

      const partialRunId = randomUUID();
      const partialStarted = parseMcpToolResult(await pollMcp('start_job_audit', {
        job_id: jobTicketCode,
        audit_run_id: partialRunId
      }));
      assert.strictEqual(partialStarted.state, 'active');
      const partialFinalization = finalization(80, [
        { label: 'planning', tokens: 20 },
        { label: 'source review', tokens: 30 }
      ], '2026-08-05T10:00:30Z', {
        status: 'partial',
        reasonCode: 'session_interrupted',
        mainSession: 'partial'
      });
      const partial = parseMcpToolResult(await pollMcp('end_job_audit', {
        job_id: jobTicketCode,
        audit_run_id: partialRunId,
        handoff_type: 'interrupted',
        finalization: partialFinalization
      }));
      assert.strictEqual(partial.state, 'completed');
      assert.strictEqual(partial.publication, 'final');
      assert.strictEqual(partial.run_normalized_total_tokens, 80);
      assert.strictEqual(partial.cumulative, undefined);

      const commentsAfterPartial = await pollFor(listRawJobComments,
        (comments) => comments.some((comment) =>
          comment.body?.includes(partialRunId)));
      const partialNote = commentsAfterPartial.find((comment) =>
        comment.body?.includes(partialRunId));
      assert(partialNote, `Partial audit note missing: ${JSON.stringify(commentsAfterPartial)}`);
      assertMachineOnlyAuditNote(partialNote);
      assert(partialNote.body.includes('Source: codex'), partialNote.body);
      assert(partialNote.body.includes('Coverage: main partial'), partialNote.body);
      assert(partialNote.body.includes('Measurement limitation'), partialNote.body);
      assert(partialNote.body.includes('session_interrupted'), partialNote.body);
      assert.strictEqual(commentsAfterPartial.filter((comment) =>
        comment.body?.includes(partialRunId)).length, 1);

      const interruptedRunId = randomUUID();
      const interruptedStarted = parseMcpToolResult(await pollMcp('start_job_audit', {
        job_id: jobTicketCode,
        audit_run_id: interruptedRunId
      }));
      assert.strictEqual(interruptedStarted.state, 'active');
      const interruptedMarker = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: jobTicketCode,
        audit_run_id: interruptedRunId,
        bucket: 'implementation',
        marker_sequence: 1
      }));
      assert.strictEqual(interruptedMarker.state, 'marked');
      const interruptedCheckpoint = parseMcpToolResult(await pollMcp('set_job_audit_phase', {
        job_id: jobTicketCode,
        audit_run_id: interruptedRunId,
        bucket: 'implementation',
        marker_sequence: 1,
        finalization: finalization(40, [
          { label: 'planning', tokens: 40 }
        ], '2026-08-05T10:01:00Z')
      }));
      assert.strictEqual(interruptedCheckpoint.state, 'checkpointed');
      assert.strictEqual(interruptedCheckpoint.publication, 'checkpoint');
      assert.strictEqual(interruptedCheckpoint.identity_verified, true);
      assert.match(interruptedCheckpoint.checkpoint_identity_fingerprint,
        /^sha256-v1:[0-9a-f]{64}$/);
      const interruptedComments = await pollFor(listRawJobComments,
        (comments) => comments.some((comment) =>
          comment.body?.includes(interruptedRunId)
          && comment.body?.includes('checkpoint:1')));
      const durableBeforeEnd = interruptedComments.find((comment) =>
        comment.body?.includes(interruptedRunId)
        && comment.body?.includes('checkpoint:1'));
      assert(durableBeforeEnd,
        `Interrupted run checkpoint was not durable before end: ${JSON.stringify(interruptedComments)}`);
      assertMachineOnlyAuditNote(durableBeforeEnd);
      assert(!interruptedComments.some((comment) =>
        comment.body?.includes(interruptedRunId)
        && comment.body?.includes('Audit publication: <code>final</code>')),
      'A run that was never ended must not invent a terminal snapshot');
    }).timeout(600000);
  });
}
