import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarket,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, mcpText, readOptionVotes, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration, userConfiguration) {
  describe('#test mcp voting and author rights', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let userClient;
    let marketId;
    let adminId;
    let userId;
    let uclusionToken;
    let planningStages;

    before(async function () {
      this.timeout(300000);
      // The full suite bootstraps these in usersTest; keep this file standalone.
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      if (!userConfiguration.idToken) {
        userConfiguration.idToken = await loginUserToIdentity(userConfiguration);
      }
      const response = await loginUserToAccountAndGetToken(adminConfiguration);
      accountClient = response.client;
      accountToken = response.accountToken;
      const result = await accountClient.markets.createMarket({ name: 'MCP voting',
        market_type: 'PLANNING' });
      marketId = result.market.id;
      planningStages = result.stages;
      adminClient = await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const adminUser = await adminClient.users.get();
      adminId = adminUser.id;
      userClient = await loginUserToMarketInvite(userConfiguration, result.market.invite_capability);
      const user = await userClient.users.get();
      userId = user.id;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
      const ready = await pollFor(async () => {
        const versions = await accountClient.summaries.versions(accountToken, [marketId]);
        return versions.signatures?.find((entry) => entry.market_id === marketId)?.signatures
          ?.find((entry) => entry.type === 'market_capability')?.object_versions || [];
      }, (capabilities) => capabilities.length >= 3);
      assert(ready.length >= 3, 'Both humans and the planning AI must be ready before one-shot writes');
    });

    // Backend effects propagate async so poll until the expected state or time runs out and the
    // caller's assert reports what is still wrong
    async function pollFor(fetcher, isDone) {
      let result = await fetcher();
      for (let i = 0; i < 20 && !isDone(result); i += 1) {
        await sleep(3000);
        result = await fetcher();
      }
      return result;
    }

    // The AI user is created async on market creation so retry the MCP call until it works
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

    // Membership in an inline market is granted async so retry the login until it works
    async function pollLogin(configuration, inlineMarketId) {
      for (let i = 0; i < 19; i += 1) {
        try {
          return await loginUserToMarket(configuration, inlineMarketId);
        } catch (error) {
          await sleep(3000);
        }
      }
      return loginUserToMarket(configuration, inlineMarketId);
    }

    async function getTicketCode(client, investibleId, marketInfoId) {
      const fetcher = async () => {
        const investibles = await client.markets.getMarketInvestibles(
          [{ investible: { id: investibleId, version: 1 }, market_infos: [{ id: marketInfoId, version: 1 }] }]);
        return investibles?.[0]?.market_infos?.[0]?.ticket_code;
      };
      const ticketCode = await pollFor(fetcher, (code) => code);
      assert(ticketCode, `Ticket code missing for ${investibleId}`);
      return ticketCode;
    }

    // A question with an inline single vote decision market holding two approvable options
    async function makeVotingQuestion(body) {
      const question = await adminClient.investibles.createComment(undefined, marketId, body,
        null, 'QUESTION');
      const inlineMarket = await accountClient.markets.createMarket({ market_type: 'DECISION',
        parent_comment_id: question.id });
      const inlineMarketId = inlineMarket.market.id;
      const inlineUserClient = await pollLogin(userConfiguration, inlineMarketId);
      const inlineAdminClient = await loginUserToMarket(adminConfiguration, inlineMarketId);
      const proposedStage = inlineMarket.stages.find((stage) => stage.name === 'Proposed');
      const approvableStage = inlineMarket.stages.find((stage) => stage.name === 'Approvable');
      const options = [];
      for (const name of ['First option', 'Second option']) {
        const option = await inlineUserClient.investibles.create({ groupId: inlineMarketId, name,
          description: `${name} of the voting question.` });
        const optionId = option.investible.id;
        const marketInfoId = option.market_infos[0].id;
        await inlineAdminClient.investibles.stateChange(optionId, { current_stage_id: proposedStage.id,
          stage_id: approvableStage.id });
        options.push({ id: optionId, marketInfoId,
          ticketCode: option.market_infos[0].ticket_code ||
            await getTicketCode(inlineAdminClient, optionId, marketInfoId) });
      }
      return { question, inlineMarketId, inlineUserClient, inlineAdminClient,
        optionA: options[0], optionB: options[1] };
    }

    // Investments key off the market info id, not the investible id (see users_invest range key)
    async function getInvestment(client, ownerId, option) {
      const investments = await client.markets.listInvestments(ownerId,
        [{ type_object_id: `investible_${option.marketInfoId}`, version: 1 }]);
      return (investments || []).find((investment) => investment.investible_id === option.id);
    }

    function isLiveInvestment(investment) {
      return !!investment && !investment.deleted &&
        (investment.quantity === undefined || investment.quantity > 0);
    }

    async function listMarketComments(targetMarketId, client = adminClient) {
      const versions = await accountClient.summaries.versions(accountToken, [targetMarketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === targetMarketId);
      const commentVersions = new Map();
      (marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const current = commentVersions.get(version.object_id_one) || 0;
          commentVersions.set(version.object_id_one, Math.max(current, version.version));
        });
      if (commentVersions.size === 0) {
        return [];
      }
      return client.investibles.getMarketComments(
        [...commentVersions].map(([id, version]) => ({ id, version })));
    }

    async function findCommentByMarker(marker) {
      const comments = await pollFor(
        () => listMarketComments(marketId),
        (fetched) => fetched.some((comment) => comment.body?.includes(marker)));
      return comments.find((comment) => comment.body?.includes(marker));
    }

    async function listInlineInvestibleIds(inlineMarketId) {
      const versions = await accountClient.summaries.versions(accountToken, [inlineMarketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === inlineMarketId);
      return [...new Set((marketEntry?.signatures || [])
        .filter((signature) => signature.type === 'investible')
        .flatMap((signature) => (signature.object_versions || [])
          .map((version) => version.object_id_one)))];
    }

    async function listInlineInvestibles(inlineMarketId, client) {
      const versions = await accountClient.summaries.versions(accountToken, [inlineMarketId]);
      const marketEntry = (versions.signatures || [])
        .find((entry) => entry.market_id === inlineMarketId);
      const signatures = marketEntry?.signatures || [];
      const investibleVersions = new Map();
      signatures
        .filter((signature) => signature.type === 'investible')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const current = investibleVersions.get(version.object_id_one) || 0;
          investibleVersions.set(version.object_id_one, Math.max(current, version.version));
        });
      const marketInfoVersions = new Map();
      signatures
        .filter((signature) => signature.type === 'market_investible')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => {
          const byInvestible = marketInfoVersions.get(version.object_id_two) || new Map();
          const current = byInvestible.get(version.object_id_one) || 0;
          byInvestible.set(version.object_id_one, Math.max(current, version.version));
          marketInfoVersions.set(version.object_id_two, byInvestible);
        });
      const requested = [...investibleVersions]
        .map(([id, version]) => ({
          investible: { id, version },
          market_infos: [...(marketInfoVersions.get(id) || [])]
            .map(([marketInfoId, marketInfoVersion]) => ({
              id: marketInfoId,
              version: marketInfoVersion
            }))
        }))
        .filter((signature) => signature.market_infos.length > 0);
      return requested.length === 0 ? [] : client.markets.getMarketInvestibles(requested);
    }

    async function getJobStage(job) {
      const marketInfo = job.market_infos.find((info) => info.market_id === marketId) ||
        job.market_infos[0];
      const fetched = await adminClient.markets.getMarketInvestibles([{
        investible: { id: job.investible.id, version: 1 },
        market_infos: [{ id: marketInfo.id, version: 1 }]
      }]);
      const currentInfo = fetched?.[0]?.market_infos?.find((info) => info.market_id === marketId) ||
        fetched?.[0]?.market_infos?.[0];
      return currentInfo?.stage;
    }

    function toolResult(response) {
      const result = JSON.parse(response).result;
      assert.notStrictEqual(result.isError, true, `MCP request was refused: ${response}`);
      return result;
    }

    async function makeMcpQuestion(marker, initialVote) {
      const job = await adminClient.investibles.create({
        groupId: marketId, name: `Explained options ${marker}`,
        description: 'A question whose initial recommendation is part of creation.'
      });
      const jobCode = await getTicketCode(adminClient, job.investible.id, job.market_infos[0].id);
      const response = await mcpCall(adminConfiguration, uclusionToken, 'ask_question', {
        job_id: jobCode, question: `Which approach ${marker}?`,
        options: [
          { name: `First ${marker}`, description: 'The established approach.' },
          { name: `Second ${marker}`, description: 'The narrower alternative.' }
        ],
        initial_vote: initialVote
      });
      toolResult(response);
      const question = await findCommentByMarker(`Which approach ${marker}?`);
      assert(question?.inline_market_id, 'Creation must persist a question with options');
      const client = await pollLogin(adminConfiguration, question.inline_market_id);
      const options = await pollFor(() => listInlineInvestibles(question.inline_market_id, client),
        (values) => values.length === 2 && values.every((option) => option.market_infos[0].ticket_code));
      assert.strictEqual(options.length, 2);
      return { jobCode, question, client, options };
    }

    async function assertRecommendation(context, optionName, certainty, reason) {
      const votes = await pollFor(
        () => readOptionVotes(context.client, context.question.created_by, context.options),
        (values) => values.length === 1 && values[0].option_name === optionName &&
          values[0].quantity === [0, 5, 25, 50, 75, 100][certainty] &&
          values[0].reason?.body?.includes(reason));
      assert.strictEqual(votes.length, 1, 'The AI must hold exactly one preferred For vote');
      const [vote] = votes;
      assert.strictEqual(vote.option_name, optionName, 'The vote must bind to the selected created option');
      assert.strictEqual(vote.quantity, [0, 5, 25, 50, 75, 100][certainty]);
      assert.strictEqual(vote.user_id, context.question.created_by);
      assert(vote.reason && !vote.reason.deleted, 'The counted vote must reference a live reason');
      assert.strictEqual(vote.reason.comment_type, 'JUSTIFY');
      assert.strictEqual(vote.reason.created_by, context.question.created_by);
      assert.strictEqual(vote.reason.investible_id, vote.option_id);
      assert(vote.reason.body.includes(reason));
      const markdown = await pollFor(() => mcpCall(adminConfiguration, uclusionToken, 'get_job', {
        short_code_id: context.question.ticket_code
      }), (text) => text.includes(reason));
      assert(markdown.includes(reason), 'A reload must expose the saved vote reason');
      // B-all-657: the reader must be able to tell which option the vote was cast on
      // from the vote's own header, without parsing its reason prose.
      const optionCode = context.options
        .find((option) => option.investible.id === vote.option_id)?.market_infos[0]?.ticket_code;
      assert(optionCode, 'The voted option must carry a ticket code to anchor on');
      const optionAnchor = `${context.question.ticket_code}_${optionCode}`.toLowerCase();
      const rendered = mcpText(markdown);
      assert(rendered.includes(`#### Option ${optionCode}<a name="${optionAnchor}"></a>`),
        `The option header must carry its question qualified anchor: ${rendered}`);
      assert(new RegExp(`Vote <a name="${optionAnchor}_\\d+"></a>`).test(rendered),
        `The vote must render attached to option ${optionCode}: ${rendered}`);
      return vote;
    }

    it('binds a combined question recommendation to the actual created option and reason', async () => {
      const marker = randomUUID();
      const reason = `Prefer the narrower second approach ${marker}`;
      const context = await makeMcpQuestion(marker,
        { new_option_index: 1, certainty: 3, reason });
      assert.notStrictEqual(context.question.created_by, adminId);
      assert(!context.question.resolved, 'The AI recommendation must leave the question open');
      await assertRecommendation(context, `Second ${marker}`, 3, reason);
    }).timeout(360000);

    it('selects an added option by its index within the new batch', async () => {
      const marker = randomUUID();
      const context = await makeMcpQuestion(marker,
        { new_option_index: 0, certainty: 3, reason: `Initial preference ${marker}` });
      const originalIds = context.options.map((option) => option.investible.id).sort();
      const reason = `The new fourth approach resolves the tradeoff ${marker}`;
      toolResult(await mcpCall(adminConfiguration, uclusionToken, 'add_options', {
        question_id: context.question.ticket_code,
        options: [
          { name: `Third ${marker}`, description: 'Another possibility.' },
          { name: `Fourth ${marker}`, description: 'The newly preferred possibility.' }
        ],
        initial_vote: { new_option_index: 1, certainty: 4, reason }
      }));
      context.options = await pollFor(
        () => listInlineInvestibles(context.question.inline_market_id, context.client),
        (options) => options.length === 4);
      assert.strictEqual(context.options.length, 4);
      assert.deepStrictEqual(context.options.filter((option) => originalIds.includes(option.investible.id))
        .map((option) => option.investible.id).sort(), originalIds);
      await assertRecommendation(context, `Fourth ${marker}`, 4, reason);
    }).timeout(360000);

    it('reaffirms an existing preference with fresh reasoning when adding options', async () => {
      const marker = randomUUID();
      const context = await makeMcpQuestion(marker,
        { new_option_index: 0, certainty: 3, reason: `Original preference ${marker}` });
      const selected = context.options.find((option) => option.investible.name === `First ${marker}`);
      const reason = `The established approach still costs less ${marker}`;
      toolResult(await mcpCall(adminConfiguration, uclusionToken, 'add_options', {
        question_id: context.question.ticket_code,
        options: [{ name: `Alternative ${marker}`, description: 'A more expensive alternative.' }],
        initial_vote: { existing_option_id: selected.market_infos[0].ticket_code, certainty: 5, reason }
      }));
      context.options = await pollFor(
        () => listInlineInvestibles(context.question.inline_market_id, context.client),
        (options) => options.length === 3);
      assert.strictEqual(context.options.length, 3);
      const vote = await assertRecommendation(context, `First ${marker}`, 5, reason);
      assert.strictEqual(vote.option_id, selected.investible.id);
    }).timeout(360000);

    it('refuses invalid initial votes before creating questions, options or a converted job', async () => {
      const marker = randomUUID();
      const context = await makeMcpQuestion(marker,
        { new_option_index: 0, certainty: 3, reason: `Valid baseline ${marker}` });
      const inlineVersions = await accountClient.summaries.versions(
        accountToken, [context.question.inline_market_id]);
      const stageReferences = inlineVersions.signatures
        .find((entry) => entry.market_id === context.question.inline_market_id).signatures
        .filter((entry) => entry.type === 'stage').flatMap((entry) => entry.object_versions || [])
        .map((entry) => ({ id: entry.object_id_one, version: entry.version }));
      const stages = await context.client.markets.listStages(stageReferences);
      const proposed = stages.find((stage) => stage.name === 'Proposed');
      assert(proposed, 'The inline fixture must have a non-Approvable stage');
      const unavailable = context.options.find((option) => option.investible.name === `Second ${marker}`);
      await context.client.investibles.stateChange(unavailable.investible.id, {
        current_stage_id: unavailable.market_infos[0].stage, stage_id: proposed.id
      });
      const demoted = await pollFor(
        () => listInlineInvestibles(context.question.inline_market_id, context.client),
        (options) => options.some((option) => option.investible.id === unavailable.investible.id &&
          option.market_infos[0].stage === proposed.id));
      assert(demoted.some((option) => option.investible.id === unavailable.investible.id &&
        option.market_infos[0].stage === proposed.id));
      toolResult(await mcpCall(adminConfiguration, uclusionToken, 'add_bug', {
        bug: `Unconverted bug ${marker}`, severity: 'YELLOW'
      }));
      const bug = await findCommentByMarker(`Unconverted bug ${marker}`);
      assert(bug?.ticket_code && !bug.investible_id);
      const beforeComments = await listMarketComments(marketId);
      const beforeJobIds = await listInlineInvestibleIds(marketId);
      const beforeOptionIds = context.options.map((option) => option.investible.id).sort();
      const invalidVotes = [
        undefined,
        { new_option_index: 0, certainty: 3, reason: '   ' },
        { new_option_index: 1, certainty: 3, reason: 'Out of bounds' },
        { new_option_index: true, certainty: 3, reason: 'Not an integer index' },
        { new_option_index: 0, certainty: true, reason: 'Not an integer certainty' },
        { new_option_index: 0, certainty: 6, reason: 'Certainty too high' },
        { certainty: 3, reason: 'Missing selector' },
        { new_option_index: 0, existing_option_id: context.options[0].market_infos[0].ticket_code,
          certainty: 3, reason: 'Two selectors' },
        { existing_option_id: unavailable.market_infos[0].ticket_code,
          certainty: 3, reason: 'The existing option is not Approvable' }
      ];
      async function refuse(tool, args) {
        const result = JSON.parse(await mcpCall(adminConfiguration, uclusionToken, tool, args)).result;
        assert.strictEqual(result.isError, true, `${tool} must refuse invalid vote input`);
      }
      for (const initialVote of invalidVotes) {
        const args = { options: [{ name: `Must not exist ${marker}`, description: 'Invalid request.' }],
          ...(initialVote === undefined ? {} : { initial_vote: initialVote }) };
        await refuse('ask_question', { ...args, job_id: context.jobCode, question: `Rejected ${marker}` });
        await refuse('ask_question', { ...args, job_id: bug.ticket_code, question: `Rejected bug ${marker}` });
        await refuse('add_options', { ...args, question_id: context.question.ticket_code });
      }
      await refuse('add_options', {
        question_id: context.question.ticket_code,
        options: [{ name: `Must not exist ${marker}`, description: 'Invalid existing preference.' }],
        initial_vote: { existing_option_id: 'O-99999999', certainty: 3, reason: 'Missing option' }
      });
      for (const options of [undefined, []]) {
        await refuse('ask_question', {
          job_id: context.jobCode, question: `Rejected open question ${marker}`,
          ...(options === undefined ? {} : { options }),
          initial_vote: { new_option_index: 0, certainty: 3, reason: 'No option exists' }
        });
      }
      const afterComments = await listMarketComments(marketId);
      assert.deepStrictEqual(afterComments.map((comment) => comment.id).sort(),
        beforeComments.map((comment) => comment.id).sort(), 'Refused inputs must create no comments');
      const unchangedBug = afterComments.find((comment) => comment.id === bug.id);
      assert(!unchangedBug.investible_id, 'Invalid conversion must leave the bug at view level');
      assert.deepStrictEqual((await listInlineInvestibleIds(marketId)).sort(), beforeJobIds.sort(),
        'Invalid conversion must not create a destination job');
      assert.deepStrictEqual((await listInlineInvestibles(context.question.inline_market_id, context.client))
        .map((option) => option.investible.id).sort(), beforeOptionIds);
      await assertRecommendation(context, `First ${marker}`, 3, `Valid baseline ${marker}`);
    }).timeout(600000);

    it('should mark non-primary question input advisory and keep the job blocked until resolve', async () => {
      const marker = randomUUID();
      const doableStage = planningStages.find((stage) => stage.name === 'Doable');
      const requiresInputStage = planningStages.find((stage) => stage.name === 'Requires Input');
      assert(doableStage && requiresInputStage,
        'Planning market should include Doable and Requires Input');

      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Primary responder integration ${marker}`,
        description: 'AI-authored questions use current human assignees as primary responders.',
        assignments: [adminId]
      });
      const jobTicket = job.market_infos[0].ticket_code ||
        await getTicketCode(adminClient, job.investible.id, job.market_infos[0].id);
      const initialStage = await getJobStage(job);
      if (initialStage !== doableStage.id) {
        await adminClient.investibles.stateChange(job.investible.id, {
          current_stage_id: initialStage,
          stage_id: doableStage.id
        });
      }
      const reachedDoable = await pollFor(() => getJobStage(job),
        (stageId) => stageId === doableStage.id);
      assert.strictEqual(reachedDoable, doableStage.id, 'Job should be Doable before the AI asks');

      const questionMarker = `Which primary-responder path ${marker}?`;
      const asked = await pollMcp('ask_question', {
        job_id: jobTicket,
        question: questionMarker,
        options: [
          { name: `First path ${marker}`, description: 'The first integration-test direction.' },
          { name: `Second path ${marker}`, description: 'The second integration-test direction.' }
        ],
        initial_vote: { new_option_index: 0, certainty: 3,
          reason: 'The first direction is the narrower integration change.' }
      });
      const questionCodeMatch = asked.match(/\bQ-[A-Za-z0-9-]+\b/);
      assert(questionCodeMatch, `ask_question should return a question code: ${asked}`);
      const questionCode = questionCodeMatch[0];
      const question = await findCommentByMarker(questionMarker);
      assert(question?.inline_market_id, 'AI question should have an inline decision market');

      const blockedStage = await pollFor(() => getJobStage(job),
        (stageId) => stageId === requiresInputStage.id);
      assert.strictEqual(blockedStage, requiresInputStage.id,
        'An open AI-authored question should move a Doable job to Requires Input');

      const optionIds = await pollFor(
        () => listInlineInvestibleIds(question.inline_market_id),
        (ids) => ids.length >= 2);
      assert(optionIds.length >= 2, 'AI question should create two option investibles');
      const inlineUserClient = await pollLogin(userConfiguration, question.inline_market_id);
      const inlineAdminClient = await pollLogin(adminConfiguration, question.inline_market_id);

      const userReplyMarker = `Advisory user reply ${marker}`;
      await userClient.investibles.createComment(job.investible.id, marketId,
        userReplyMarker, question.id);
      await inlineUserClient.markets.updateInvestment(optionIds[0], 100, 0);

      const advisoryReply =
        '##### Advisory response from non-primary human: does not answer this question.';
      const advisoryVote =
        '#### Advisory vote from non-primary human: does not answer this question.';
      const advisoryMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: questionCode }),
        (markdown) => markdown.includes(userReplyMarker) &&
          markdown.includes(advisoryReply) && markdown.includes(advisoryVote));
      assert(advisoryMarkdown.includes(advisoryReply),
        'A non-assignee reply should be explicitly marked advisory');
      assert(advisoryMarkdown.includes(advisoryVote),
        'A non-assignee option vote should be explicitly marked advisory');
      const advisoryThread = await pollFor(
        () => pollMcp('get_job', { short_code_id: questionCode, thread_only: true }),
        (markdown) => markdown.includes(userReplyMarker) &&
          markdown.includes(advisoryReply) && markdown.includes(advisoryVote));
      assert(advisoryThread.includes(advisoryReply) && advisoryThread.includes(advisoryVote),
        'A targeted thread reload must preserve advisory reply and vote labels');
      assert.strictEqual(await getJobStage(job), requiresInputStage.id,
        'Advisory replies and votes must not unblock the job');

      await adminClient.investibles.updateAssignments(job.investible.id, [userId]);
      const primaryMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: questionCode }),
        (markdown) => markdown.includes(userReplyMarker) &&
          !markdown.includes(advisoryReply) && !markdown.includes(advisoryVote));
      assert(!primaryMarkdown.includes(advisoryReply) && !primaryMarkdown.includes(advisoryVote),
        'Reassignment should immediately make the new assignee\'s existing input primary');
      assert.strictEqual(await getJobStage(job), requiresInputStage.id,
        'The open question should remain blocking across assignment changes');

      const adminReplyMarker = `Former assignee advisory reply ${marker}`;
      await adminClient.investibles.createComment(job.investible.id, marketId,
        adminReplyMarker, question.id);
      await inlineAdminClient.markets.updateInvestment(optionIds[1], 100, 0);
      const reassignedMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: questionCode }),
        (markdown) => markdown.includes(adminReplyMarker) &&
          markdown.includes(advisoryReply) && markdown.includes(advisoryVote));
      assert(reassignedMarkdown.includes(advisoryReply) && reassignedMarkdown.includes(advisoryVote),
        'The former assignee\'s new reply and vote should render as advisory');

      // Resolve is intentionally performed by the now non-primary admin: any human may delegate
      // an AI-authored question back to the AI, and that closes the stage lock without choosing.
      await adminClient.investibles.updateComment(question.id, undefined, true);
      const restoredStage = await pollFor(() => getJobStage(job),
        (stageId) => stageId === doableStage.id);
      assert.strictEqual(restoredStage, doableStage.id,
        'Human Resolve should delegate the answer and restore the prior Doable stage');
      const restoredMarkdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: jobTicket }),
        (markdown) => markdown.includes('This job is in stage Doable.'));
      assert(restoredMarkdown.includes('This job is in stage Doable.'),
        'get_job should report the restored executable stage after Resolve');
    }).timeout(600000);

    it('should move AI vote via MCP approval on single vote question', async () => {
      const { question, inlineAdminClient, optionA, optionB } = await makeVotingQuestion(
        'Does the AI vote move on second approval?');
      await pollMcp('approve_job_or_option',
        { job_or_option_id: optionA.ticketCode, parent_question_short_code_id: question.ticket_code,
          certainty: 3, reason: 'The first option is the initial preference.' });
      // The moderator's new vote notification carries the AI user id as its suffix
      const voteMessage = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) =>
          message.type_object_id?.startsWith(`UNREAD_VOTE_${optionA.id}_`));
      }, (message) => message);
      assert(voteMessage, 'MCP approval should notify the question creator of the AI vote');
      const aiUserId = voteMessage.type_object_id.substring(`UNREAD_VOTE_${optionA.id}_`.length);
      const firstVote = await pollFor(() => getInvestment(inlineAdminClient, aiUserId, optionA),
        isLiveInvestment);
      assert(isLiveInvestment(firstVote), 'MCP approval should invest the AI user in the first option');
      await pollMcp('approve_job_or_option',
        { job_or_option_id: optionB.ticketCode, parent_question_short_code_id: question.ticket_code,
          certainty: 4, reason: 'New evidence makes the second option preferable.' });
      const moved = await pollFor(async () => {
        return { a: await getInvestment(inlineAdminClient, aiUserId, optionA),
          b: await getInvestment(inlineAdminClient, aiUserId, optionB) };
      }, (votes) => !isLiveInvestment(votes.a) && isLiveInvestment(votes.b));
      assert(isLiveInvestment(moved.b), 'AI vote should be live on the second option');
      assert(!isLiveInvestment(moved.a),
        'MCP approval should move the AI vote off the first option instead of duplicating per C-all-1168');
      assert(moved.b.comment_id, 'The changed preference must retain its explained reason');
      const [reason] = await inlineAdminClient.investibles.getMarketComments([
        { id: moved.b.comment_id, version: 1 }
      ]);
      assert.strictEqual(reason?.created_by, aiUserId);
      assert.strictEqual(reason?.investible_id, optionB.id);
      assert.strictEqual(reason?.comment_type, 'JUSTIFY');
      assert(reason.body.includes('New evidence makes the second option preferable.'));
    }).timeout(240000);

    it('should keep the same justification and its replies when MCP votes again on the same option', async () => {
      const marker = randomUUID();
      const firstReason = `Initial preference ${marker}`;
      const secondReason = `Raised on new evidence ${marker}`;
      const replyMarker = `Reply that must stay on the vote ${marker}`;
      const { question, inlineAdminClient, inlineMarketId, optionA } = await makeVotingQuestion(
        `Does a second MCP vote keep the reason thread ${marker}?`);
      await pollMcp('approve_job_or_option',
        { job_or_option_id: optionA.ticketCode, parent_question_short_code_id: question.ticket_code,
          certainty: 3, reason: firstReason });
      const voteMessage = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) =>
          message.type_object_id?.startsWith(`UNREAD_VOTE_${optionA.id}_`));
      }, (message) => message);
      assert(voteMessage, 'MCP approval should notify the question creator of the AI vote');
      const aiUserId = voteMessage.type_object_id.substring(`UNREAD_VOTE_${optionA.id}_`.length);
      const firstVote = await pollFor(() => getInvestment(inlineAdminClient, aiUserId, optionA),
        (investment) => isLiveInvestment(investment) && investment.comment_id);
      assert(isLiveInvestment(firstVote), 'MCP approval should invest the AI user in the option');
      const firstCommentId = firstVote.comment_id;
      await inlineAdminClient.investibles.createComment(optionA.id, inlineMarketId, replyMarker,
        firstCommentId);
      await pollFor(() => listMarketComments(inlineMarketId, inlineAdminClient),
        (comments) => comments.some((comment) => comment.body?.includes(replyMarker)));
      await pollMcp('approve_job_or_option',
        { job_or_option_id: optionA.ticketCode, parent_question_short_code_id: question.ticket_code,
          certainty: 4, reason: secondReason });
      const secondVote = await pollFor(() => getInvestment(inlineAdminClient, aiUserId, optionA),
        (investment) => isLiveInvestment(investment) && investment.comment_id === firstCommentId);
      assert.strictEqual(secondVote.comment_id, firstCommentId,
        'A second MCP vote on the same option must keep the original justification id');
      const [reason] = await pollFor(
        () => inlineAdminClient.investibles.getMarketComments([{ id: firstCommentId, version: 1 }]),
        (comments) => comments[0]?.body?.includes(secondReason));
      assert.strictEqual(reason?.id, firstCommentId);
      assert(reason.body.includes(secondReason), 'The kept justification must show the new reason');
      const markdown = await pollFor(
        () => pollMcp('get_job', { short_code_id: question.ticket_code }),
        (text) => text.includes(secondReason) && text.includes(replyMarker));
      assert(markdown.includes(replyMarker),
        'A reply on the original reason must still appear on the job after the second vote');
    }).timeout(240000);

    it('should update the existing option without consuming its human suggestion', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Option update integration ${marker}`,
        description: 'Job for exercising canonical MCP option updates.'
      });
      const jobTicket = job.market_infos[0].ticket_code ||
        await getTicketCode(adminClient, job.investible.id, job.market_infos[0].id);
      const questionMarker = `Which option should change ${marker}?`;
      const originalName = `Original option ${marker}`;
      const originalDescription = 'The option that will receive a suggestion.';
      const asked = await pollMcp('ask_question', {
        job_id: jobTicket,
        question: questionMarker,
        options: [
          { name: originalName, description: originalDescription },
          { name: `Unchanged option ${marker}`, description: 'The other canonical option.' }
        ],
        initial_vote: { new_option_index: 0, certainty: 3,
          reason: 'The original option is the preferred starting point for refinement.' }
      });
      const questionCodeMatch = asked.match(/\bQ-[A-Za-z0-9-]+\b/);
      assert(questionCodeMatch, `ask_question should return a question code: ${asked}`);
      const questionCode = questionCodeMatch[0];
      const question = await findCommentByMarker(questionMarker);
      assert(question?.inline_market_id, 'MCP question should have an inline decision market');
      const inlineMarketId = question.inline_market_id;
      const inlineUserClient = await pollLogin(userConfiguration, inlineMarketId);
      const inlineAdminClient = await pollLogin(adminConfiguration, inlineMarketId);
      const beforeOptions = await pollFor(
        () => listInlineInvestibles(inlineMarketId, inlineAdminClient),
        (options) => options.length === 2 && options.some((option) =>
          option.investible.name === originalName &&
          option.market_infos.some((info) => info.ticket_code)));
      assert.strictEqual(beforeOptions.length, 2, 'MCP question should create exactly two options');
      const targetBefore = beforeOptions.find((option) => option.investible.name === originalName);
      assert(targetBefore, 'The option chosen for update should be discoverable');
      const optionInfoBefore = targetBefore.market_infos.find((info) =>
        info.market_id === inlineMarketId) || targetBefore.market_infos[0];
      const optionId = targetBefore.investible.id;
      const optionCode = optionInfoBefore?.ticket_code;
      assert(optionCode, `Option code missing for ${optionId}`);

      const suggestionMarker = `Human suggestion ${marker}`;
      const suggestion = await inlineUserClient.investibles.createComment(
        optionId, inlineMarketId, suggestionMarker, null, 'SUGGEST');
      const updatedName = `Updated option ${marker}`;
      const updatedDescription = `Updated option body ${marker}.`;
      const updateResult = await pollMcp('update_option', {
        parent_question_short_code_id: questionCode,
        option_id: optionCode,
        name: updatedName,
        description: updatedDescription
      });
      assert(updateResult.includes(questionCode) && updateResult.includes(optionCode),
        `update_option should name ${questionCode} and ${optionCode}: ${updateResult}`);

      const afterOptions = await pollFor(
        () => listInlineInvestibles(inlineMarketId, inlineAdminClient),
        (options) => {
          const target = options.find((option) => option.investible.id === optionId);
          return options.length === beforeOptions.length && target?.investible.name === updatedName &&
            target.investible.description?.includes(updatedDescription);
        });
      assert.strictEqual(afterOptions.length, beforeOptions.length,
        'Updating an option must not create a replacement option');
      const targetAfter = afterOptions.find((option) => option.investible.id === optionId);
      assert(targetAfter, 'The same option investible should remain after update');
      const optionInfoAfter = targetAfter.market_infos.find((info) =>
        info.market_id === inlineMarketId) || targetAfter.market_infos[0];
      assert.strictEqual(targetAfter.investible.name, updatedName,
        'update_option should fully replace the option name');
      assert(targetAfter.investible.description?.includes(updatedDescription),
        'update_option should fully replace the option description');
      assert(!targetAfter.investible.description?.includes(originalDescription),
        'update_option should remove the prior option description');
      assert.strictEqual(optionInfoAfter?.ticket_code, optionCode,
        'Updating an option must preserve its stable O-code');

      const comments = await pollFor(
        () => listMarketComments(inlineMarketId, inlineUserClient),
        (fetched) => fetched.some((comment) => comment.id === suggestion.id));
      const preservedSuggestion = comments.find((comment) => comment.id === suggestion.id);
      assert.strictEqual(preservedSuggestion?.comment_type, 'SUGGEST',
        'The human suggestion should remain a separate suggestion artifact');
      assert.strictEqual(preservedSuggestion?.investible_id, optionId,
        'The human suggestion should remain attached to the updated option');
      assert(preservedSuggestion?.body?.includes(suggestionMarker) && !preservedSuggestion.resolved,
        'Updating the option must not rewrite or resolve its human suggestion');
    }).timeout(600000);

    it('should vote against then for a suggestion via MCP', async () => {
      const suggestion = await adminClient.investibles.createComment(undefined, marketId,
        'Should we take the other approach instead?', null, 'SUGGEST');
      // Enabling voting on a suggestion creates an inline INITIATIVE market whose single
      // option the backend makes at market creation - vote_on_suggestion finds it by listing
      const inlineMarket = await accountClient.markets.createMarket({ market_type: 'INITIATIVE',
        parent_comment_id: suggestion.id });
      const option = { id: inlineMarket.investible.investible.id,
        marketInfoId: inlineMarket.investible.market_infos[0].id };
      const inlineAdminClient = await pollLogin(adminConfiguration, inlineMarket.market.id);
      await pollMcp('vote_on_suggestion',
        { suggestion_short_code: suggestion.ticket_code, is_for: false, certainty: 2,
          reason: 'Too risky as described.' });
      const voteMessage = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) =>
          message.type_object_id?.startsWith(`UNREAD_VOTE_${option.id}_`));
      }, (message) => message);
      assert(voteMessage, 'MCP suggestion vote should notify the suggestion creator of the AI vote');
      const aiUserId = voteMessage.type_object_id.substring(`UNREAD_VOTE_${option.id}_`.length);
      const against = await pollFor(() => getInvestment(inlineAdminClient, aiUserId, option),
        (investment) => !!investment && !investment.deleted && investment.quantity < 0);
      assert(against?.quantity === -25, 'Against vote should be a negative investment at certainty 2');
      await pollMcp('vote_on_suggestion',
        { suggestion_short_code: suggestion.ticket_code, is_for: true, certainty: 4 });
      const forVote = await pollFor(() => getInvestment(inlineAdminClient, aiUserId, option),
        (investment) => !!investment && !investment.deleted && investment.quantity > 0);
      assert(forVote?.quantity === 75, 'For vote should replace the against vote at certainty 4');
    }).timeout(240000);

    it('should move user vote via normal invest on single vote question', async () => {
      const { inlineUserClient, optionA, optionB } = await makeVotingQuestion(
        'Does the normal path move the vote?');
      await inlineUserClient.markets.updateInvestment(optionA.id, 100, 0);
      const firstVote = await pollFor(() => getInvestment(inlineUserClient, userId, optionA),
        isLiveInvestment);
      assert(isLiveInvestment(firstVote), 'Normal invest should record the first vote');
      await inlineUserClient.markets.updateInvestment(optionB.id, 100, 0);
      const moved = await pollFor(async () => {
        return { a: await getInvestment(inlineUserClient, userId, optionA),
          b: await getInvestment(inlineUserClient, userId, optionB) };
      }, (votes) => !isLiveInvestment(votes.a) && isLiveInvestment(votes.b));
      assert(isLiveInvestment(moved.b), 'User vote should be live on the second option');
      assert(!isLiveInvestment(moved.a), 'Normal path should move the vote off the first option');
    }).timeout(240000);

    it('should hide a deleted vote reason from get_job markdown', async () => {
      const { question, inlineMarketId, inlineUserClient, optionA } = await makeVotingQuestion(
        'Does a deleted reason stay out of the markdown?');
      const reasonMarker = 'Reason destined for deletion in markdown test.';
      const reason = await inlineUserClient.investibles.createComment(optionA.id, inlineMarketId,
        reasonMarker, null, 'JUSTIFY');
      await inlineUserClient.markets.updateInvestment(optionA.id, 100, 0, reason.id);
      const withReason = await pollFor(
        () => pollMcp('get_job', { short_code_id: question.ticket_code }),
        (markdown) => typeof markdown === 'string' && markdown.includes(reasonMarker));
      assert(withReason.includes(reasonMarker), 'Live vote reason should render in get_job markdown');
      await inlineUserClient.investibles.deleteComment(reason.id);
      // B-all-547: the reason guard checked the export wrapper instead of the comment, so a
      // deleted justification kept rendering unmarked
      const withoutReason = await pollFor(
        () => pollMcp('get_job', { short_code_id: question.ticket_code }),
        (markdown) => typeof markdown === 'string' && !markdown.includes(reasonMarker));
      assert(!withoutReason.includes(reasonMarker),
        'A deleted vote reason must not leak into get_job markdown');
    }).timeout(240000);

    it('should give anyone author rights on an AI authored question', async () => {
      const job = await adminClient.investibles.create({ groupId: marketId, name: 'Author rights job',
        description: 'Job to hang the AI authored question on.' });
      const jobTicket = job.market_infos[0].ticket_code ||
        await getTicketCode(adminClient, job.investible.id, job.market_infos[0].id);
      const marker = 'AI authored question for rights test?';
      const mcpResult = await mcpCall(adminConfiguration, uclusionToken, 'ask_question',
        { job_id: jobTicket, question: marker,
          options: [{ name: 'First direction', description: 'One way to go.' },
            { name: 'Second direction', description: 'Another way to go.' }],
          initial_vote: { new_option_index: 0, certainty: 3,
            reason: 'The first direction is the preferred starting point.' } });
      assert(mcpResult.includes('Added question with id'), `MCP ask_question response wrong: ${mcpResult}`);
      // Discover the created comment through versions since MCP only returns short codes
      const questionComment = await pollFor(async () => {
        const versions = await accountClient.summaries.versions(accountToken, [marketId]);
        const marketEntry = (versions.signatures || []).find((entry) => entry.market_id === marketId);
        const commentIds = (marketEntry?.signatures || [])
          .filter((signature) => signature.type === 'comment')
          .flatMap((signature) => (signature.object_versions || []).map((version) => version.object_id_one));
        if (commentIds.length === 0) {
          return undefined;
        }
        const comments = await adminClient.investibles.getMarketComments(
          [...new Set(commentIds)].map((id) => ({ id, version: 1 })));
        return (comments || []).find((comment) => comment.body?.includes(marker));
      }, (comment) => comment?.inline_market_id);
      assert(questionComment, 'AI authored question should be discoverable');
      assert(questionComment.created_by !== adminId && questionComment.created_by !== userId,
        'Question should be authored by the AI user');
      // Change the settings as a non author - red here means C-all-1167 is a back end problem
      await adminClient.investibles.updateComment(questionComment.id, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, true);
      const inlineMarketId = questionComment.inline_market_id;
      const inlineAdminClient = await pollLogin(adminConfiguration, inlineMarketId);
      const inlineMarket = await pollFor(() => inlineAdminClient.markets.get(),
        (market) => market.allow_multi_vote === true);
      assert(inlineMarket.allow_multi_vote === true,
        'Non author settings change should flip allow multi vote on the inline market');
      // Move an option stage as a non author
      const inlineVersions = await accountClient.summaries.versions(accountToken, [inlineMarketId]);
      const inlineEntry = (inlineVersions.signatures || []).find((entry) => entry.market_id === inlineMarketId);
      const stageIds = (inlineEntry?.signatures || [])
        .filter((signature) => signature.type === 'stage')
        .flatMap((signature) => (signature.object_versions || []).map((version) => version.object_id_one));
      const stages = await inlineAdminClient.markets.listStages(stageIds.map((id) => ({ id, version: 1 })));
      const proposedStage = stages.find((stage) => stage.name === 'Proposed');
      const approvableStage = stages.find((stage) => stage.name === 'Approvable');
      assert(proposedStage && approvableStage, 'Inline market should have Proposed and Approvable stages');
      const optionIds = (inlineEntry?.signatures || [])
        .filter((signature) => signature.type === 'investible')
        .flatMap((signature) => (signature.object_versions || []).map((version) => version.object_id_one));
      assert(optionIds.length > 0, 'AI authored question should have discoverable options');
      // MCP created options start in the approvable stage - demote one as the non author
      await inlineAdminClient.investibles.stateChange(optionIds[0],
        { current_stage_id: approvableStage.id, stage_id: proposedStage.id });
    }).timeout(240000);
  });
};
