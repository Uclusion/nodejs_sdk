import assert from 'assert';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, mcpText, pollFor, sleep } from './commonTestFunctions.js';

// J-all-517: the agent Markdown states what a record's own state allows, a Requires Input job
// names the stage it returns to, and a whole-list connection gets tool names and fields only.
export default function (adminConfiguration) {
  describe('#test agent Markdown rules, next stage and tool description types (J-all-517)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
    let stageIds;
    let uclusionToken;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps this in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const accountLogin = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = accountLogin.client;
      accountToken = accountLogin.accountToken;
      const result = await accountClient.markets.createMarket({
        name: 'Agent Markdown rules integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      stageIds = Object.fromEntries(result.stages.map((stage) => [stage.name, stage.id]));
      assert(stageIds.Doable && stageIds.Approvable, 'Planning market creation should return its stages');
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      adminClient = (await loginUserToMarketAndGetToken(adminConfiguration, marketId)).client;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
      const ready = await pollFor(async () => {
        const versions = await accountClient.summaries.versions(accountToken, [marketId]);
        return versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures
          ?.find((entry) => entry.type === 'market_capability')?.object_versions || [];
      }, (capabilities) => capabilities.length >= 2);
      assert(ready.length >= 2, 'The human and planning AI must be ready before one-shot writes');
    });

    // The AI user is created async on market creation, so retry a read or an idempotent write
    // until it works. Creations go through mcpCall once, since each call creates another item.
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

    function toolResult(raw) {
      const result = JSON.parse(raw).result;
      assert.notStrictEqual(result?.isError, true, raw);
      return result;
    }

    function createdCode(raw, prefix) {
      const result = toolResult(raw);
      const code = result.structuredContent?.short_code_id ||
        mcpText(raw).match(new RegExp(`\\b${prefix}-[^\\s/<>"]+-\\d+\\b`))?.[0];
      assert(code, `No ${prefix} short code in response: ${raw}`);
      return code;
    }

    async function compactState(jobCode) {
      return toolResult(await pollMcp('get_job', { short_code_id: jobCode, stage_only: true })).structuredContent;
    }

    async function jobStage(jobCode) {
      return (await compactState(jobCode)).stage;
    }

    async function readJob(jobCode, args = { initial_read: true }) {
      return mcpText(await pollMcp('get_job', { short_code_id: jobCode, ...args }));
    }

    async function listMarketComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const commentVersions = new Map();
      (versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          commentVersions.set(version.object_id_one,
            Math.max(commentVersions.get(version.object_id_one) || 0, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return adminClient.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    async function commentWith(marker) {
      const comments = await pollFor(() => listMarketComments(),
        (fetched) => fetched.some((comment) => comment.body?.includes(marker)));
      const comment = comments.find((candidate) => candidate.body?.includes(marker));
      assert(comment, `No comment found containing ${marker}`);
      return comment;
    }

    async function approvableJob(marker) {
      const jobCode = createdCode(await mcpCall(adminConfiguration, uclusionToken, 'add_job', {
        name: `Agent Markdown job ${marker}`, description: `A job for the agent Markdown rules ${marker}.`
      }), 'J');
      const from = await jobStage(jobCode);
      if (from !== 'Approvable') {
        await pollMcp('change_job_stage', { job_id: jobCode, from_stage: from, stage: 'Approvable' });
        await pollFor(() => jobStage(jobCode), (stage) => stage === 'Approvable');
      }
      return jobCode;
    }

    it('names the stage a Requires Input job returns to without another call', async () => {
      const marker = randomUUID();
      const jobCode = await approvableJob(marker);
      const questionText = `Which way ${marker}?`;
      const asked = toolResult(await mcpCall(adminConfiguration, uclusionToken, 'ask_question',
        { job_id: jobCode, question: questionText }));
      assert.strictEqual(asked.structuredContent.job_stage, 'Requires Input', JSON.stringify(asked));
      assert.strictEqual(asked.structuredContent.returns_to_stage, 'Approvable', JSON.stringify(asked));
      assert(asked.content[0].text.includes(
        'Once its questions and suggestions are resolved, it returns to Approvable.'), asked.content[0].text);
      const questionCode = asked.structuredContent.short_code_id;

      const waiting = await pollFor(() => compactState(jobCode), (state) => state.stage === 'Requires Input');
      assert.strictEqual(waiting.returns_to_stage, 'Approvable', JSON.stringify(waiting));
      const read = await readJob(jobCode);
      assert(read.includes('Once its questions and suggestions are resolved, the job returns to Approvable.'), read);
      assert(!read.includes('until the job returns to Doable or Reviewable'), read);

      // Changing the next stage, as the UI does, changes what the agent reads.
      const question = await commentWith(questionText);
      await adminClient.investibles.updateFormerStage(question.investible_id, stageIds.Doable);
      const changed = await pollFor(() => compactState(jobCode), (state) => state.returns_to_stage === 'Doable');
      assert.strictEqual(changed.stage, 'Requires Input');
      assert((await readJob(jobCode)).includes('the job returns to Doable.'));

      await pollMcp('resolve', { short_code_id: questionCode });
      const restored = await pollFor(() => compactState(jobCode), (state) => state.stage === 'Doable');
      assert.strictEqual(restored.returns_to_stage, undefined, JSON.stringify(restored));
    }).timeout(300000);

    it('states on each record what the agent may do there', async () => {
      const marker = randomUUID();
      const jobCode = await approvableJob(marker);
      assert((await readJob(jobCode)).includes('You may approve this job.'));

      const aiSuggestionText = `An AI idea ${marker}`;
      createdCode(await mcpCall(adminConfiguration, uclusionToken, 'make_suggestion',
        { job_id: jobCode, suggestion: aiSuggestionText }), 'S');
      const withSuggestion = await pollFor(() => readJob(jobCode),
        (text) => text.includes(aiSuggestionText));
      assert.strictEqual(await jobStage(jobCode), 'Approvable');
      assert(withSuggestion.includes(
        'You made this suggestion: do not vote on it. Only a human converts it to a task or resolves it.'),
        withSuggestion);
      assert(withSuggestion.includes('Do not approve this job yet: its open questions and suggestions must be ' +
        'resolved first.'), withSuggestion);

      const humanSuggestionText = `A human idea ${marker}`;
      createdCode(await mcpCall(adminConfiguration, uclusionToken, 'make_suggestion',
        { job_id: jobCode, suggestion: humanSuggestionText, for_human: true, is_my_lane: true }), 'S');
      const withHuman = await pollFor(() => readJob(jobCode, { short_code_id: jobCode, sections: ['assistance'] }),
        (text) => text.includes(humanSuggestionText));
      assert(/Voting is (not )?enabled on this suggestion: /.test(withHuman), withHuman);

      // A human resolving the AI's suggestion without a reply or vote declines it.
      const aiSuggestion = await commentWith(aiSuggestionText);
      await adminClient.investibles.updateComment(aiSuggestion.id, undefined, true);
      const humanSuggestion = await commentWith(humanSuggestionText);
      await adminClient.investibles.updateComment(humanSuggestion.id, undefined, true);
      const resolved = await pollFor(() => readJob(jobCode, { short_code_id: jobCode, sections: ['resolved'] }),
        (text) => text.includes('A human resolved your suggestion without replying or voting'));
      assert(resolved.includes('its proposal is declined and the risk accepted. Revisit it only for new ' +
        'evidence, naming that evidence.'), resolved);
      assert(resolved.includes('This suggestion is resolved and reopens only when a human asks.'), resolved);
      const settled = await pollFor(() => readJob(jobCode, { short_code_id: jobCode, sections: [] }),
        (text) => text.includes('You may approve this job.'));
      assert(settled.includes('You may approve this job.'), settled);

      toolResult(await pollMcp('approve_job_or_option',
        { job_or_option_id: jobCode, certainty: 3, reason: `Worth doing ${marker}.` }));
      const approved = await pollFor(() => readJob(jobCode, { short_code_id: jobCode, sections: [] }),
        (text) => text.includes('The AI has already voted on approving this job'));
      assert(approved.includes('do not approve it again.'), approved);

      const optionJob = await approvableJob(`${marker}-options`);
      const asked = toolResult(await mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
        job_id: optionJob,
        question: `Pick one ${marker}?`,
        options: [{ name: 'First way', description: 'Go the first way.' },
          { name: 'Second way', description: 'Go the second way.' }],
        initial_vote: { new_option_index: 0, certainty: 3, reason: 'The first way is simpler.' }
      }));
      const questionCode = asked.structuredContent.short_code_id;
      const open = await readJob(questionCode, { short_code_id: questionCode, thread_only: true });
      const optionStatements = (open.match(/This option accepts votes\.|This option takes no votes until it is Approvable\./g) || []);
      assert.strictEqual(optionStatements.length, 2, open);
      assert(open.includes('This option accepts votes.'), open);

      await pollMcp('resolve', { short_code_id: questionCode });
      const closed = await pollFor(() => readJob(questionCode, { short_code_id: questionCode, thread_only: true }),
        (text) => text.includes('This question is resolved:'));
      assert(closed.includes('This question is resolved: its options take no votes or comments, and it reopens ' +
        'only when a human asks.'), closed);
      assert.strictEqual(
        (closed.match(/Its question is resolved, so this option takes no votes or comments\./g) || []).length, 2,
        closed);
    }).timeout(300000);

    async function listTools(descriptionType) {
      const headers = { 'Content-Type': 'application/json', Authorization: uclusionToken };
      if (descriptionType) {
        headers['X-Uclusion-Tool-Descriptions'] = descriptionType;
      }
      const response = await fetch(adminConfiguration.baseURL.replace('https://', 'https://investibles.') + '/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      });
      assert(response.ok, `MCP tools/list failed with status ${response.status}`);
      const envelope = await response.json();
      assert(envelope.result?.tools, `MCP tools/list returned no tools: ${JSON.stringify(envelope)}`);
      return envelope.result.tools;
    }

    // Description annotations anywhere in a schema; a property named description is a field.
    function descriptionAnnotations(schema, path = '') {
      if (Array.isArray(schema)) {
        return schema.flatMap((child, index) => descriptionAnnotations(child, `${path}[${index}]`));
      }
      if (!schema || typeof schema !== 'object') {
        return [];
      }
      const found = typeof schema.description === 'string' ? [path || '/'] : [];
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const [name, child] of Object.entries(value)) {
            found.push(...descriptionAnnotations(child, `${path}/${name}`));
          }
        } else if (key !== 'description') {
          found.push(...descriptionAnnotations(value, `${path}/${key}`));
        }
      }
      return found;
    }

    it('lists tool names and fields without descriptions for a whole-list connection', async () => {
      const undeclared = await listTools();
      const onDemand = await listTools('on-demand');
      const wholeList = await listTools('whole-list');
      assert.deepStrictEqual(onDemand, undeclared, 'An on-demand connection gets the full catalog');
      assert(undeclared.every((tool) => tool.description), 'The full catalog describes every tool');
      assert(descriptionAnnotations(undeclared.map((tool) => tool.inputSchema)).length > 0);
      assert.deepStrictEqual(wholeList.map((tool) => tool.name), undeclared.map((tool) => tool.name));
      for (const tool of wholeList) {
        assert.strictEqual(tool.description, undefined, `${tool.name} keeps its description`);
        assert.deepStrictEqual(descriptionAnnotations(tool.inputSchema), [],
          `${tool.name} keeps field descriptions`);
        const full = undeclared.find((candidate) => candidate.name === tool.name);
        assert.deepStrictEqual(tool.annotations, full.annotations, `${tool.name} annotations differ`);
        assert.deepStrictEqual(Object.keys(tool.inputSchema.properties || {}),
          Object.keys(full.inputSchema.properties || {}), `${tool.name} fields differ`);
      }
      const askQuestion = wholeList.find((tool) => tool.name === 'ask_question');
      assert(askQuestion.inputSchema.properties.options.items.properties.description,
        'A field named description is a field and stays');
    }).timeout(120000);
  });
}
