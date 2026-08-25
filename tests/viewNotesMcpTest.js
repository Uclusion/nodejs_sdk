import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration) {
  describe('#test view level notes in get_job (J-all-381)', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
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
        name: 'View notes MCP integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
    });

    // Backend effects propagate async so poll until the expected state or time runs out and the
    // caller's assert reports what is still wrong.
    async function pollFor(fetcher, isDone) {
      let result = await fetcher();
      for (let i = 0; i < 20 && !isDone(result); i += 1) {
        await sleep(3000);
        result = await fetcher();
      }
      return result;
    }

    // The AI user is created async on market creation, so retry the MCP call until it works.
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

    async function getTicketCode(investible) {
      const marketInfo = investible.market_infos[0];
      if (marketInfo.ticket_code) {
        return marketInfo.ticket_code;
      }
      const fetcher = async () => {
        const fetched = await adminClient.markets.getMarketInvestibles([{
          investible: { id: investible.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        return fetched?.[0]?.market_infos?.[0]?.ticket_code;
      };
      const ticketCode = await pollFor(fetcher, (code) => code);
      assert(ticketCode, `Ticket code missing for ${investible.investible.id}`);
      return ticketCode;
    }

    async function listHumanMarketComments() {
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

    it('defaults view notes to hidden and shows Show AI notes only in the note view', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `View notes job ${marker}`,
        description: 'Job whose get_job carries its view standing notes.'
      });
      const jobTicketCode = await getTicketCode(job);

      // T-all-2433: a view level note is born hidden from the AI - Show AI is explicit opt-in.
      const noteMarker = `Prefer integration tests over expensive mocks ${marker}`;
      const note = await adminClient.investibles.createComment(null, marketId,
        noteMarker, null, 'REPORT');
      assert(note.is_visible === false,
        `View note should default is_visible false: ${JSON.stringify(note)}`);

      let jobMarkdown = await pollMcp('get_job', { short_code_id: jobTicketCode });
      assert(!jobMarkdown.includes(noteMarker),
        'get_job must not include a view note that is not marked Show AI');

      // Flip Show AI on - only body-less update of is_visible, exactly what the UI checkbox does.
      await adminClient.investibles.updateComment(note.id, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        true, note.version);

      // T-all-2434: get_job now carries the note in a View Notes section.
      jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(noteMarker)
      );
      assert(jobMarkdown.includes('#### View Notes'),
        'get_job should render a View Notes section for Show AI view notes');
      assert(jobMarkdown.includes(noteMarker),
        'get_job should include the Show AI view note body');

      // T-all-2435: a job only gets the notes of the view it is in. The group name feeds
      // the ticket sub code, so keep it short - the market is fresh per run anyway.
      const groupResponse = await adminClient.markets.createGroup({ name: 'Engineering' });
      const otherGroupId = groupResponse.group.id;
      const otherJob = await adminClient.investibles.create({
        groupId: otherGroupId,
        name: `Other view job ${marker}`,
        description: 'Job in a different view that must not receive the first view notes.'
      });
      const otherTicketCode = await getTicketCode(otherJob);
      const otherMarkdown = await pollMcp('get_job', { short_code_id: otherTicketCode });
      assert(!otherMarkdown.includes(noteMarker),
        'A job in another view must not receive notes from the first view');
    }).timeout(600000);

    it('creates and updates an AI view note with add_view_note and notifies the view (T-all-2459)', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `AI note job ${marker}`,
        description: 'Job whose short code targets the AI view note.'
      });
      const jobTicketCode = await getTicketCode(job);

      // S-1 on Q-all-404: exactly one targeting code - both is rejected before any write
      const rejected = await pollMcp('add_view_note', {
        view_short_code_id: jobTicketCode,
        update_note_short_code_id: 'R-fake-1',
        note: `Never lands ${marker}`
      });
      assert(rejected.includes('not both'), `Expected XOR rejection: ${rejected}`);

      const lessonMarker = `Do not fix the back end for a test-only race ${marker}`;
      const created = await pollMcp('add_view_note', {
        view_short_code_id: jobTicketCode,
        note: lessonMarker
      });
      assert(created.includes('Added view note'), `Expected view note creation: ${created}`);
      const noteTicketCode = created.match(/Added view note (\S+) and link/)?.[1];
      assert(noteTicketCode && noteTicketCode.startsWith('R-'),
        `Expected an R- ticket code in: ${created}`);

      // Born Show AI: the AI note rides along in get_job with no is_visible flip
      let jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(lessonMarker)
      );
      assert(jobMarkdown.includes(lessonMarker),
        'get_job should include the AI view note without a Show AI flip');

      // Q-all-406: unlike the human note above, the AI note notifies the view humans
      const messages = await pollFor(
        () => getMessages(adminConfiguration),
        (candidates) => candidates.some((message) =>
          message.type_object_id.startsWith('UNREAD_COMMENT_') &&
          message.market_id_user_id.startsWith(marketId))
      );
      assert(messages.some((message) => message.type_object_id.startsWith('UNREAD_COMMENT_') &&
          message.market_id_user_id.startsWith(marketId)),
        'AI view note creation should notify the view humans');

      // C-1 on Q-all-405: an update folds the lesson into the existing note, never a second note
      const revisedMarker = `Fix the test barrier instead ${marker}`;
      const updated = await pollMcp('add_view_note', {
        update_note_short_code_id: noteTicketCode,
        note: revisedMarker
      });
      assert(updated.includes('Updated view note'), `Expected view note update: ${updated}`);
      jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(revisedMarker)
      );
      assert(jobMarkdown.includes(revisedMarker), 'get_job should carry the revised note text');
      assert(!jobMarkdown.includes(lessonMarker),
        'The update must revise the existing note, not add a second one');

      // C-all-1458: no targeting code at all lands the note in the default view
      const defaultMarker = `Default view lesson ${marker}`;
      const defaulted = await pollMcp('add_view_note', { note: defaultMarker });
      assert(defaulted.includes('Added view note'), `Expected default view creation: ${defaulted}`);
      jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(defaultMarker)
      );
      assert(jobMarkdown.includes(defaultMarker),
        'A note created with no code should land in the default view');
    }).timeout(600000);

    it('keeps AI-created job and task notes out of get_job (B-all-584)', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Hidden AI notes job ${marker}`,
        description: 'Job whose regular AI notes should not become AI context.'
      });
      const jobTicketCode = await getTicketCode(job);
      const taskMarker = `Hidden AI notes task ${marker}`;
      const task = await adminClient.investibles.createComment(
        job.investible.id,
        marketId,
        taskMarker,
        null,
        'TODO'
      );
      assert(task.ticket_code, `Task ticket code missing: ${JSON.stringify(task)}`);

      const jobNoteMarker = `Job note hidden from AI ${marker}`;
      const taskNoteMarker = `Task note hidden from AI ${marker}`;
      await pollMcp('add_info', {
        short_code_id: jobTicketCode,
        info: jobNoteMarker,
        tz: 'America/Los_Angeles'
      });
      await pollMcp('add_info', {
        short_code_id: task.ticket_code,
        info: taskNoteMarker,
        tz: 'America/Los_Angeles'
      });

      const humanComments = await pollFor(
        listHumanMarketComments,
        (comments) => [jobNoteMarker, taskNoteMarker].every((noteMarker) =>
          comments.some((comment) => comment.body?.includes(noteMarker)))
      );
      const jobNote = humanComments.find((comment) => comment.body?.includes(jobNoteMarker));
      const taskNote = humanComments.find((comment) => comment.body?.includes(taskNoteMarker));
      assert(jobNote, `AI-created job note did not synchronize: ${JSON.stringify(humanComments)}`);
      assert(taskNote, `AI-created task note did not synchronize: ${JSON.stringify(humanComments)}`);
      assert.strictEqual(jobNote.is_visible, false,
        `AI-created job note should default Show AI off: ${JSON.stringify(jobNote)}`);
      assert.strictEqual(taskNote.is_visible, false,
        `AI-created task note should default Show AI off: ${JSON.stringify(taskNote)}`);
      assert.strictEqual(jobNote.investible_id, job.investible.id);
      assert.strictEqual(taskNote.investible_id, job.investible.id);
      assert(!jobNote.associated_comment_id,
        `Job note should not be task-associated: ${JSON.stringify(jobNote)}`);
      assert.strictEqual(taskNote.associated_comment_id, task.id,
        `Task note association missing: ${JSON.stringify(taskNote)}`);

      const fullJobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', {
          short_code_id: jobTicketCode,
          include_all_resolved: true
        }),
        (markdown) => markdown.includes(jobNoteMarker) && markdown.includes(taskNoteMarker)
      );
      assert(fullJobMarkdown.includes(jobNoteMarker) && fullJobMarkdown.includes(taskNoteMarker),
        'Full get_job did not reach both AI note barriers');
      const jobMarkdown = await pollMcp('get_job', { short_code_id: jobTicketCode });
      assert(jobMarkdown.includes(taskMarker), 'get_job must retain the ordinary task');
      assert(!jobMarkdown.includes(jobNoteMarker),
        'get_job must omit a regular AI-created job note by default');
      assert(!jobMarkdown.includes(taskNoteMarker),
        'get_job must omit a regular AI-created task note by default');
    }).timeout(600000);
  });
}
