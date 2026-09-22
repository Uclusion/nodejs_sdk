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

    function toolText(response) {
      const result = JSON.parse(response).result;
      assert(result && result.isError !== true, `MCP read failed: ${response}`);
      return (result.content || []).map((item) => item.text || '').join('\n');
    }

    async function readJob(args) {
      return toolText(await pollMcp('get_job', args));
    }

    function hasNoteReference(markdown, note) {
      const code = note.ticket_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${code} version ${note.version}(?![0-9])`).test(markdown);
    }

    function assertView(markdown, groupId = marketId) {
      assert(markdown.includes(`Workspace ID: ${marketId}. View ID: ${groupId}.`),
        `The read must identify its stable workspace and view: ${markdown}`);
      assert(markdown.includes('Standing view notes:'), `The read must inventory its view notes: ${markdown}`);
    }

    async function commentState(codeOrId, bodyMarker) {
      const matches = (comment) => (comment.id === codeOrId || comment.ticket_code === codeOrId)
        && comment.ticket_code && (!bodyMarker || comment.body?.includes(bodyMarker));
      const comments = await pollFor(listHumanMarketComments, (items) => items.some(matches));
      const comment = comments.find(matches);
      assert(comment, `Comment ${codeOrId} did not reach its expected stored state`);
      return comment;
    }

    async function readNote(note, bodyMarker) {
      const markdown = await pollFor(
        () => readJob({ short_code_id: note.ticket_code, thread_only: true }),
        (text) => text.includes(bodyMarker) && text.includes(`Note version: ${note.version}.`)
      );
      assert(markdown.includes(bodyMarker), `Explicit note read lost its body: ${markdown}`);
      assert(markdown.includes(`Note version: ${note.version}.`),
        `Explicit note read lost its actual stored version: ${markdown}`);
      return markdown;
    }

    it('inventories Show AI notes only in their view and fetches their bodies explicitly', async () => {
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

      const hiddenNote = await commentState(note.id, noteMarker);
      let jobMarkdown = await readJob({ short_code_id: jobTicketCode });
      assertView(jobMarkdown);
      assert(jobMarkdown.includes('Standing view notes: none.'));
      assert(!jobMarkdown.includes(hiddenNote.ticket_code));
      assert(!jobMarkdown.includes(noteMarker),
        'get_job must not include a view note that is not marked Show AI');

      // Flip Show AI on - only body-less update of is_visible, exactly what the UI checkbox does.
      const shownNote = await adminClient.investibles.updateComment(note.id, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        true, note.version);

      const visibleNote = { ...hiddenNote, version: shownNote.version };
      jobMarkdown = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => hasNoteReference(markdown, visibleNote)
      );
      assertView(jobMarkdown);
      assert(hasNoteReference(jobMarkdown, visibleNote), 'Show AI must add the note code and version');
      assert(!jobMarkdown.includes(noteMarker), 'The inventory must omit the standing-note body');
      await readNote(visibleNote, noteMarker);

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
      const otherMarkdown = await readJob({ short_code_id: otherTicketCode });
      assertView(otherMarkdown, otherGroupId);
      assert(otherMarkdown.includes('Standing view notes: none.'));
      assert(!otherMarkdown.includes(visibleNote.ticket_code));
      assert(!otherMarkdown.includes(noteMarker),
        'A job in another view must not receive notes from the first view');

      await adminClient.investibles.updateComment(note.id, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        false, shownNote.version);
      const removed = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => !markdown.includes(visibleNote.ticket_code)
      );
      assert(removed.includes('Standing view notes: none.'),
        'Removing Show AI must remove the inventory entry, so an agent drops the cached note');
    }).timeout(600000);

    it('retains view identity and note versions on scoped and narrow reads without bodies', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Scoped read job ${marker}`,
        description: `Job whose scoped reloads must not re-send the view note ${marker}.`
      });
      const jobTicketCode = await getTicketCode(job);

      const noteMarker = `Standing note that must not ride along on reloads ${marker}`;
      const created = await pollMcp('add_view_note', {
        view_short_code_id: jobTicketCode,
        note: noteMarker
      });
      assert(created.includes('Added view note'), `Expected view note creation: ${created}`);
      // B-all-659: the link must reach the structured result, not only the sentence.
      const createdNote = JSON.parse(created).result?.structuredContent;
      assert(createdNote?.link?.endsWith(createdNote.short_code_id),
        `add_view_note create must return its link in structuredContent: ${created}`);

      const note = await commentState(createdNote.short_code_id, noteMarker);
      const unscoped = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => hasNoteReference(markdown, note)
      );
      assertView(unscoped);
      assert(hasNoteReference(unscoped, note));
      assert(!unscoped.includes(noteMarker));

      const scoped = await readJob(
        { short_code_id: jobTicketCode, sections: ['tasks'] });
      assert(!scoped.includes(noteMarker),
        `A scoped get_job must not re-send the view note body: ${scoped}`);
      assertView(scoped);
      assert(hasNoteReference(scoped, note), 'Scoped reads must still reveal changed view-note versions');

      // Scoping still preserves job-level changes as well as the view inventory.
      assert(scoped.includes(jobTicketCode),
        'A scoped get_job must still identify the job');
      assert(scoped.includes(`Scoped read job ${marker}`),
        'A scoped get_job must still render the job name, so a renamed job is visible');
      assert(scoped.includes(`Job whose scoped reloads must not re-send the view note ${marker}`),
        'A scoped get_job must still render the description, so an edited description is visible');
      assert(/This job is in stage /.test(scoped),
        'A scoped get_job must still render the stage, so a stage change is visible');

      const task = await adminClient.investibles.createComment(
        job.investible.id, marketId, `Narrow view-context task ${marker}`, null, 'TODO');
      const taskRow = await commentState(task.id);
      const reply = await adminClient.investibles.createComment(
        job.investible.id, marketId, `Narrow view-context reply ${marker}`, task.id);
      const replyRow = await commentState(reply.id);
      for (const row of [taskRow, replyRow]) {
        const narrow = await readJob({ short_code_id: row.ticket_code, thread_only: true });
        assertView(narrow);
        assert(hasNoteReference(narrow, note), 'Narrow job-child reads must carry the same version inventory');
        assert(!narrow.includes(noteMarker));
        assert(/This job is in stage /.test(narrow));
      }
      const sameViewJob = await adminClient.investibles.create({
        groupId: marketId, name: `Another same-view job ${marker}`, description: 'Reuse current view-note bodies.'
      });
      const sameView = await readJob({ short_code_id: await getTicketCode(sameViewJob) });
      assertView(sameView);
      assert(hasNoteReference(sameView, note));
      assert(!sameView.includes(noteMarker));
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

      // Born Show AI: the AI note enters the inventory without a visibility flip.
      const originalNote = await commentState(noteTicketCode, lessonMarker);
      let jobMarkdown = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => hasNoteReference(markdown, originalNote)
      );
      assertView(jobMarkdown);
      assert(hasNoteReference(jobMarkdown, originalNote));
      assert(!jobMarkdown.includes(lessonMarker));
      await readNote(originalNote, lessonMarker);

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
      // B-all-659: the link must reach the structured result, not only the sentence.
      const updatedNote = JSON.parse(updated).result?.structuredContent;
      assert(updatedNote?.link?.endsWith(updatedNote.short_code_id),
        `add_view_note update must return its link in structuredContent: ${updated}`);
      const revisedNote = await commentState(noteTicketCode, revisedMarker);
      assert(revisedNote.version > originalNote.version, 'Editing the note must change its advertised version');
      jobMarkdown = await pollFor(
        () => readJob({ short_code_id: jobTicketCode, sections: ['tasks'] }),
        (markdown) => hasNoteReference(markdown, revisedNote)
      );
      assert(hasNoteReference(jobMarkdown, revisedNote), 'A scoped reload must advertise the revised version');
      assert(!hasNoteReference(jobMarkdown, originalNote));
      assert(!jobMarkdown.includes(revisedMarker) && !jobMarkdown.includes(lessonMarker));
      const revisedBody = await readNote(revisedNote, revisedMarker);
      assert(!revisedBody.includes(lessonMarker), 'Fetching the changed R-code must return its current body');

      // C-all-1458: no targeting code at all lands the note in the default view
      const defaultMarker = `Default view lesson ${marker}`;
      const defaulted = await pollMcp('add_view_note', { note: defaultMarker });
      assert(defaulted.includes('Added view note'), `Expected default view creation: ${defaulted}`);
      const defaultCode = JSON.parse(defaulted).result?.structuredContent?.short_code_id;
      assert(defaultCode, `Default view note must return its code: ${defaulted}`);
      const defaultNote = await commentState(defaultCode, defaultMarker);
      jobMarkdown = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => hasNoteReference(markdown, defaultNote)
      );
      assert(hasNoteReference(jobMarkdown, defaultNote),
        'A note created with no code should land in the default view');
      assert(!jobMarkdown.includes(defaultMarker));
      await readNote(defaultNote, defaultMarker);
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
      const jobNoteResult = await pollMcp('add_info', {
        short_code_id: jobTicketCode,
        info: jobNoteMarker,
        tz: 'America/Los_Angeles'
      });
      // B-all-659: the link must reach the structured result, not only the sentence.
      const addedInfo = JSON.parse(jobNoteResult).result?.structuredContent;
      assert(addedInfo?.link?.endsWith(addedInfo.short_code_id),
        `add_info must return its link in structuredContent: ${jobNoteResult}`);
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
        () => readJob({
          short_code_id: jobTicketCode,
          include_all_resolved: true
        }),
        (markdown) => markdown.includes(jobNoteMarker) && markdown.includes(taskNoteMarker)
      );
      assert(fullJobMarkdown.includes(jobNoteMarker) && fullJobMarkdown.includes(taskNoteMarker),
        'Full get_job did not reach both AI note barriers');
      const jobMarkdown = await readJob({ short_code_id: jobTicketCode });
      assert(jobMarkdown.includes(taskMarker), 'get_job must retain the ordinary task');
      assert(!jobMarkdown.includes(jobNoteMarker),
        'get_job must omit a regular AI-created job note by default');
      assert(!jobMarkdown.includes(taskNoteMarker),
        'get_job must omit a regular AI-created task note by default');
      const explicitNotes = await readJob({ short_code_id: jobTicketCode, sections: ['notes'] });
      assert(explicitNotes.includes(jobNoteMarker) && explicitNotes.includes(taskNoteMarker),
        'An explicit Notes section must include ordinary notes even with Show AI off');
      await readNote(jobNote, jobNoteMarker);

      const shownJobNote = await adminClient.investibles.updateComment(jobNote.id,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, true, jobNote.version);
      const replyMarker = `Ordinary note reply must not opt its body in ${marker}`;
      await adminClient.investibles.createComment(job.investible.id, marketId, replyMarker, jobNote.id);
      const explicitWithReply = await pollFor(
        () => readJob({ short_code_id: jobNote.ticket_code, thread_only: true }),
        (markdown) => markdown.includes(replyMarker)
      );
      assert(explicitWithReply.includes(replyMarker));
      assert(explicitWithReply.includes(jobNoteMarker));
      const afterReply = await readJob({ short_code_id: jobTicketCode });
      assert(!afterReply.includes(jobNoteMarker),
        'Show AI and a reply must not inject an ordinary note body into a default read');
      assert(!afterReply.includes(replyMarker));
      assert(shownJobNote.is_visible, 'The fixture must exercise the Show AI override');

      await adminClient.investibles.updateComment(jobNote.id, undefined, true);
      const resolvedHistory = await pollFor(
        () => readJob({ short_code_id: jobTicketCode, include_all_resolved: true }),
        (markdown) => markdown.includes(`Resolved Note ${jobNote.ticket_code}`)
          && markdown.includes(jobNoteMarker)
      );
      assert(resolvedHistory.includes(`Resolved Note ${jobNote.ticket_code}`));
      assert(resolvedHistory.includes(jobNoteMarker));
      const afterResolve = await readJob({ short_code_id: jobTicketCode });
      assert(!afterResolve.includes(jobNoteMarker),
        'Resolved status must not expose even a compressed ordinary note body by default');
    }).timeout(600000);
  });
}
