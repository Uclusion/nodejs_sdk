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
    let stages;
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
      stages = result.stages;
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
      return new RegExp(`${code} v${note.version}(?![0-9])`).test(markdown);
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
      const versionValue = new RegExp(`(?<![\\w.,-])${note.version}(?![\\w,-]|\\.\\d)`, 'g');
      const bodyVersions = (note.body.replace(/<[^>]*>/g, '').match(versionValue) || []).length;
      const hasVersion = (markdown) =>
        (markdown.replace(/<[^>]*>/g, '').match(versionValue) || []).length > bodyVersions;
      const markdown = await pollFor(
        () => readJob({ short_code_id: note.ticket_code, thread_only: true }),
        (text) => text.includes(bodyMarker) && text.includes(note.ticket_code) &&
          hasVersion(text)
      );
      assert(markdown.includes(bodyMarker), `Explicit note read lost its body: ${markdown}`);
      assert(markdown.includes(note.ticket_code));
      assert(hasVersion(markdown),
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
      assert(!removed.includes(visibleNote.ticket_code),
        'Turning off Show AI must remove the previously visible note');
    }).timeout(600000);

    it('retains view identity and note versions on scoped and narrow reads without bodies', async () => {
      const marker = randomUUID();
      const description = `Job whose scoped reloads must not re-send the view note ${marker}.`;
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Scoped read job ${marker}`,
        description
      });
      const jobTicketCode = await getTicketCode(job);

      const noteMarker = `Standing note that must not ride along on reloads ${marker}`;
      const created = await pollMcp('add_view_note', {
        view_short_code_id: jobTicketCode,
        note: noteMarker
      });
      // B-all-659: the link must reach the structured result, not only the sentence.
      const createdNote = JSON.parse(created).result?.structuredContent;
      assert(createdNote?.link?.endsWith(createdNote.short_code_id),
        `add_view_note create must return its link in structuredContent: ${created}`);

      const note = await commentState(createdNote.short_code_id, noteMarker);
      const unscoped = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => hasNoteReference(markdown, note)
      );
      assert(hasNoteReference(unscoped, note));
      assert(!unscoped.includes(noteMarker));
      assert(unscoped.includes(description), 'Unscoped reads must retain the job description');

      const taskMarker = `Narrow view-context task ${marker}`;
      const task = await adminClient.investibles.createComment(
        job.investible.id, marketId, taskMarker, null, 'TODO');
      const taskRow = await commentState(task.id);
      const replyMarker = `Narrow view-context reply ${marker}`;
      const reply = await adminClient.investibles.createComment(
        job.investible.id, marketId, replyMarker, task.id);
      const replyRow = await commentState(reply.id);

      const scoped = await pollFor(
        () => readJob({ short_code_id: jobTicketCode, sections: ['tasks'] }),
        (markdown) => markdown.includes(taskMarker));
      assert(!scoped.includes(noteMarker),
        `A scoped get_job must not re-send the view note body: ${scoped}`);
      assert(hasNoteReference(scoped, note), 'Scoped reads must still reveal changed view-note versions');

      // Scoping preserves identity and stage without repeating the description.
      assert(scoped.includes(jobTicketCode),
        'A scoped get_job must still identify the job');
      assert(scoped.includes(`Scoped read job ${marker}`),
        'A scoped get_job must still render the job name, so a renamed job is visible');
      assert(scoped.includes(stages.find((stage) => stage.id === job.market_infos[0].stage).name),
        'A scoped get_job must retain the actual job stage');
      assert(!scoped.includes(description), 'Task reads must omit the job description');
      assert(scoped.includes(taskMarker), 'Task reads must still include the selected comment bodies');

      for (const sections of [[], ['description']]) {
        const narrow = await readJob({ short_code_id: jobTicketCode, sections });
        assert(hasNoteReference(narrow, note));
        assert.strictEqual(narrow.includes(description), sections.includes('description'),
          'Only an explicit description selection should include it');
        for (const body of [taskMarker, replyMarker, noteMarker]) {
          assert(!narrow.includes(body), 'A context or description read must omit comment bodies');
        }
      }
      const combined = await readJob(
        { short_code_id: jobTicketCode, sections: ['description', 'tasks'] });
      assert(combined.includes(description) && combined.includes(taskMarker),
        'Description must compose with other selected sections');
      assert(hasNoteReference(combined, note));
      assert(!combined.includes(noteMarker));

      const revisedDescription = `Current edited description ${marker}.`;
      const locked = await adminClient.investibles.lock(job.investible.id);
      await adminClient.investibles.update(job.investible.id, locked.investible.name,
        revisedDescription, undefined, undefined, undefined, undefined, undefined, undefined,
        locked.investible.version);
      const revised = await pollFor(
        () => readJob({ short_code_id: jobTicketCode, sections: ['description'] }),
        (markdown) => markdown.includes(revisedDescription));
      assert(revised.includes(revisedDescription), 'A narrow description read must return the current body');
      assert(!revised.includes(description), 'A narrow description read must drop the previous body');
      assert(hasNoteReference(revised, note));
      for (const body of [taskMarker, replyMarker, noteMarker]) {
        assert(!revised.includes(body), 'An edited description read must still omit comment bodies');
      }
      for (const row of [taskRow, replyRow]) {
        const narrow = await readJob({ short_code_id: row.ticket_code, thread_only: true });
        assert(narrow.includes(stages.find((stage) => stage.id === job.market_infos[0].stage).name),
          'A narrow job-child read must retain the actual job stage');
        assert(hasNoteReference(narrow, note), 'Narrow job-child reads must carry the same version inventory');
        assert(!narrow.includes(noteMarker));
      }
      const sameViewJob = await adminClient.investibles.create({
        groupId: marketId, name: `Another same-view job ${marker}`, description: 'Reuse current view-note bodies.'
      });
      const sameView = await readJob({ short_code_id: await getTicketCode(sameViewJob) });
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

      const lessonMarker = `Do not fix the back end for a test-only race ${marker}`;
      const rejected = await pollMcp('add_view_note', {
        view_short_code_id: jobTicketCode,
        update_note_short_code_id: 'R-fake-1',
        note: `Never lands ${marker}`
      });
      assert.strictEqual(JSON.parse(rejected).result?.isError, true,
        `Expected both-target rejection: ${rejected}`);
      const created = await pollMcp('add_view_note', {
        view_short_code_id: jobTicketCode,
        note: lessonMarker
      });
      const noteTicketCode = JSON.parse(created).result?.structuredContent?.short_code_id;
      assert(noteTicketCode && noteTicketCode.startsWith('R-'),
        `Expected an R- ticket code in: ${created}`);

      // Born Show AI: the AI note enters the inventory without a visibility flip.
      const originalNote = await commentState(noteTicketCode, lessonMarker);
      let jobMarkdown = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => hasNoteReference(markdown, originalNote)
      );
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

    it('loads active ordinary notes without a capsule and preserves explicit note scope', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Conditional AI notes job ${marker}`,
        description: 'Ordinary notes supply context until this job has a current capsule.'
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
      assert(jobMarkdown.includes(jobNoteMarker) && jobMarkdown.includes(taskNoteMarker),
        'A whole-scope read without a capsule must load active ordinary job/task notes');
      const initialMarkdown = await readJob({ short_code_id: jobTicketCode, initial_read: true });
      assert(initialMarkdown.includes(jobNoteMarker) && initialMarkdown.includes(taskNoteMarker),
        'An initial read without a capsule must load active ordinary notes');
      const scopedTasks = await readJob({
        short_code_id: jobTicketCode, initial_read: true, sections: ['tasks']
      });
      assert(!scopedTasks.includes(jobNoteMarker) && !scopedTasks.includes(taskNoteMarker),
        'Explicit task sections must retain scope even with initial_read');
      const explicitNotes = await readJob({ short_code_id: jobTicketCode, sections: ['notes'] });
      assert(explicitNotes.includes(jobNoteMarker) && explicitNotes.includes(taskNoteMarker),
        'An explicit Notes section must include ordinary notes even with Show AI off');
      await readNote(jobNote, jobNoteMarker);

      const shownJobNote = await adminClient.investibles.updateComment(jobNote.id,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, true, jobNote.version);
      const replyMarker = `Ordinary note context reply ${marker}`;
      await adminClient.investibles.createComment(job.investible.id, marketId, replyMarker, jobNote.id);
      const explicitWithReply = await pollFor(
        () => readJob({ short_code_id: jobNote.ticket_code, thread_only: true }),
        (markdown) => markdown.includes(replyMarker)
      );
      assert(explicitWithReply.includes(replyMarker));
      assert(explicitWithReply.includes(jobNoteMarker));
      const afterReply = await readJob({ short_code_id: jobTicketCode });
      assert(afterReply.includes(jobNoteMarker) && afterReply.includes(replyMarker),
        'A default read without a capsule must retain the active note thread');
      assert(shownJobNote.is_visible, 'The fixture must exercise the Show AI override');

      await adminClient.investibles.updateComment(jobNote.id, undefined, true);
      const resolvedNote = await pollFor(() => commentState(jobNote.id, jobNoteMarker),
        (note) => note.resolved === true);
      assert.strictEqual(resolvedNote.resolved, true);
      const resolvedHistory = await pollFor(
        () => readJob({ short_code_id: jobTicketCode, include_all_resolved: true }),
        (markdown) => markdown.includes(jobNote.ticket_code)
          && markdown.includes(jobNoteMarker)
      );
      assert(resolvedHistory.includes(jobNote.ticket_code));
      assert(resolvedHistory.includes(jobNoteMarker));
      const afterResolve = await readJob({ short_code_id: jobTicketCode });
      assert(!afterResolve.includes(jobNoteMarker),
        'A resolved ordinary note still requires an explicit read');

      const capsuleMarker = `Conditional notes current capsule ${marker}`;
      const capsuleResponse = await pollMcp('set_design_capsule', {
        job_id: jobTicketCode, capsule: `## Outcome\n${capsuleMarker}`
      });
      const capsule = JSON.parse(capsuleResponse).result?.structuredContent;
      assert(capsule?.capsule_short_code_id, `Capsule missing: ${capsuleResponse}`);
      const withCapsule = await pollFor(
        () => readJob({ short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(capsuleMarker)
      );
      assert(withCapsule.includes(capsuleMarker));
      assert(!withCapsule.includes(taskNoteMarker),
        'A current capsule replaces ordinary-note context on default whole-scope reads');
      const taskWithoutCapsule = await readJob({ short_code_id: task.ticket_code, initial_read: true });
      assert(taskWithoutCapsule.includes(taskNoteMarker),
        'A task without its own capsule must load ordinary notes despite the job capsule');
      assert(!taskWithoutCapsule.includes(capsuleMarker),
        'An independent task must not fall back to the job capsule');
      const notesWithCapsule = await readJob({ short_code_id: jobTicketCode, sections: ['notes'] });
      assert(notesWithCapsule.includes(taskNoteMarker) && !notesWithCapsule.includes(capsuleMarker),
        'Explicit note scope must load notes without injecting a capsule body');

      const grouped = await adminClient.investibles.createComment(
        job.investible.id, marketId, `Grouped capsule context ${marker}`, task.id);
      const groupedState = await commentState(grouped.id);
      const taskCapsuleMarker = `Task capsule context ${marker}`;
      const taskCapsuleResponse = await pollMcp('set_design_capsule', {
        job_id: jobTicketCode, task_id: groupedState.ticket_code,
        capsule: `## Outcome\n${taskCapsuleMarker}`
      });
      const taskCapsule = JSON.parse(taskCapsuleResponse).result?.structuredContent;
      assert.strictEqual(taskCapsule?.normalized_target, task.ticket_code,
        'A grouped task must select its parent task capsule');
      const persistedCapsule = await commentState(taskCapsule.capsule_short_code_id);
      const capsuleReplyMarker = `Resolved capsule discussion ${marker}`;
      const capsuleReply = await adminClient.investibles.createComment(
        job.investible.id, marketId, capsuleReplyMarker, persistedCapsule.id);
      const rootReply = await commentState(capsuleReply.id, capsuleReplyMarker);
      const capsuleAfterReply = await pollFor(() => commentState(persistedCapsule.id),
        (comment) => comment.children?.includes(capsuleReply.id));
      assert(capsuleAfterReply.children?.includes(capsuleReply.id));
      const nestedMarker = `Nested capsule context ${marker}`;
      const nestedResponse = await pollMcp('add_info', {
        short_code_id: rootReply.ticket_code, info: nestedMarker,
        tz: 'America/Los_Angeles'
      });
      const nested = JSON.parse(nestedResponse).result?.structuredContent;
      assert(nested?.short_code_id, `Nested capsule reply missing: ${nestedResponse}`);
      const nestedReply = await commentState(nested.short_code_id, nestedMarker);
      const revisedReplyMarker = `Revised nested capsule context ${marker}`;
      const revisedResponse = await pollMcp('add_info', {
        update_info_short_code_id: nestedReply.ticket_code,
        update_info_version: nestedReply.version, info: revisedReplyMarker,
        tz: 'America/Los_Angeles'
      });
      assert.strictEqual(JSON.parse(revisedResponse).result?.structuredContent?.status, 'updated');
      const deletedMarker = `Deleted capsule context ${marker}`;
      const deletedReply = await adminClient.investibles.createComment(
        job.investible.id, marketId, deletedMarker, capsuleReply.id);
      await commentState(deletedReply.id);
      await adminClient.investibles.deleteComment(deletedReply.id);
      await adminClient.investibles.updateComment(capsuleReply.id, undefined, true);
      const discussion = await pollFor(listHumanMarketComments, (items) =>
        items.some((comment) => comment.id === nestedReply.id
          && comment.body?.includes(revisedReplyMarker))
        && items.some((comment) => comment.id === capsuleReply.id && comment.resolved === true)
        && items.some((comment) => comment.id === deletedReply.id && comment.deleted === true));
      assert(discussion.some((comment) => comment.id === capsuleReply.id && comment.resolved === true));
      assert.strictEqual(discussion.find((comment) => comment.id === persistedCapsule.id)?.version,
        capsuleAfterReply.version,
        'Nested and edited capsule comments must not require a body-version change');
      for (const targetCode of [task.ticket_code, groupedState.ticket_code]) {
        const initial = await pollFor(
          () => readJob({ short_code_id: targetCode, initial_read: true }),
          (markdown) => markdown.includes(revisedReplyMarker) && !markdown.includes(deletedMarker)
        );
        assert(initial.includes(taskCapsuleMarker));
        assert(initial.includes(capsuleReplyMarker),
          'A whole-scope capsule read must include resolved discussion replies');
        assert(initial.includes(revisedReplyMarker),
          'A fresh read must load edited comments even at an unchanged capsule version');
        assert(!initial.includes(deletedMarker) && !initial.includes(capsuleMarker));
      }
      const jobInitial = await readJob({ short_code_id: jobTicketCode, initial_read: true });
      assert(jobInitial.includes(capsuleMarker) && !jobInitial.includes(taskCapsuleMarker),
        'A job must keep its own capsule instead of a task capsule');
      const isolatedReply = await readJob({
        short_code_id: nestedReply.ticket_code, initial_read: true, thread_only: true
      });
      assert(isolatedReply.includes(revisedReplyMarker));
      assert(!isolatedReply.includes(capsuleReplyMarker) && !isolatedReply.includes(taskCapsuleMarker),
        'An explicit reply read must retain its subtree even with initial_read');
      const scopedJob = await readJob({
        short_code_id: jobTicketCode, initial_read: true, sections: ['tasks']
      });
      assert(!scopedJob.includes(capsuleMarker) && !scopedJob.includes(taskCapsuleMarker)
        && !scopedJob.includes(revisedReplyMarker),
      'An explicit section read must not inject capsule bodies or discussion');
    }).timeout(600000);
  });
}
