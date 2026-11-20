import assert from 'assert';
import { loginUserToMarket } from '../src/utils.js';
import { mcpCall, mcpText, pollFor } from '../tests/commonTestFunctions.js';
import { pollMcp, SemanticDevFixture } from './semanticFixture.js';
import { assertQuestionClosureState } from './questionClosureAssertions.js';

function result(response) {
  const payload = JSON.parse(response).result;
  assert(payload && !payload.isError, `Fixture MCP operation failed: ${response}`);
  return payload.structuredContent || JSON.parse(mcpText(response));
}

function currentCapsule(comment, jobId) {
  return comment.investible_id === jobId && comment.comment_type === 'REPORT' &&
    comment.notification_type === 'BLUE' && comment.pinned && !comment.resolved &&
    !comment.deleted && !comment.is_machine_only && !comment.associated_comment_id &&
    !comment.reply_id && !comment.root_comment_id;
}

export class QuestionClosureDevFixture extends SemanticDevFixture {
  async call(name, args) {
    return mcpCall(this.primaryConfiguration, this.uclusionToken, name, args);
  }

  async createJob(name, description, capsule) {
    const job = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.doableStageId,
      assignments: [this.adminId],
      name: `${name} ${this.marker}`,
      description
    });
    const jobCode = await this.jobCodeFor(job);
    const saved = result(await this.call('set_design_capsule', { job_id: jobCode, capsule }));
    return { job, jobCode, capsuleCode: saved.capsule_short_code_id };
  }

  async ask(jobCode, question, options) {
    const args = { job_id: jobCode, question: `${question} (${this.marker})` };
    if (options) {
      args.options = options.map((name) => ({ name, description: name }));
      args.initial_vote = { new_option_index: 0, certainty: 3,
        reason: 'This was the initial proposal before the human continued the discussion.' };
    }
    return result(await this.call('ask_question', args));
  }

  async humanReply(scope, question, body) {
    await scope.client.investibles.createComment(
      scope.jobId, scope.marketId, body, question.comment_id
    );
  }

  async initializeScenario() {
    this.closure = await this.createJob('Storyboard planning',
      'Plan a future storyboard. Its screenshot choice remains with the primary human. ' +
      'Do not implement anything or publish the future storyboard capsule until that choice is answered.',
      '## Summary\nThe existing landing page remains unchanged during storyboard planning. ' +
      'No implementation or trial delivery is authorized by this contract.');
    const scope = { client: this.adminClient, marketId: this.marketId,
      jobId: this.closure.job.investible.id };
    const task = result(await this.call('add_task', {
      job_id: this.closure.jobCode,
      task: 'Future storyboard design: the design role owns the unwritten task capsule. ' +
        'Preserve the agreed product explanation and wait for the primary human screenshot choice. ' +
        `Keep this task open; implementation is not requested. (${this.marker})`
    }));
    this.closure.taskCode = task.short_code_id;
    this.closure.withdrawn = await this.ask(this.closure.jobCode,
      'Which proposed evaluation should accompany the storyboard?',
      ['Repository migration trial', 'Competitor comparison demo']);
    const parent = await this.findComment(`Which proposed evaluation should accompany the storyboard? (${this.marker})`);
    this.nestedMarketId = parent.inline_market_id;
    this.nestedClient = await loginUserToMarket(this.primaryConfiguration, this.nestedMarketId);
    const options = await pollFor(() => this.listInvestibles(this.nestedMarketId),
      (values) => values.length === 2 && values.every((item) =>
        item.market_infos.some((info) => info.ticket_code)), 20, 1000);
    const option = options.find((item) => item.investible.name === 'Repository migration trial');
    assert(option, 'Fixture option did not converge');
    const nestedScope = { client: this.nestedClient, marketId: this.nestedMarketId,
      jobId: option.investible.id };
    this.closure.nested = [];
    for (const [question, explanation] of [
      ['What does retained context mean here?', 'It means the saved decisions and their reasons.'],
      ['Why was the comparison proposed?', 'It was an optional way to explain the old evaluation proposal.']
    ]) {
      const created = await this.nestedClient.investibles.createComment(option.investible.id,
        this.nestedMarketId, `${question} (${this.marker})`, null, 'QUESTION');
      const comments = await pollFor(() => this.listComments(this.nestedMarketId, this.nestedClient),
        (values) => values.some((item) => item.id === created.id && item.ticket_code), 20, 1000);
      const questionRecord = comments.find((item) => item.id === created.id);
      assert(questionRecord?.ticket_code, 'Nested explanation question did not converge');
      const asked = { comment_id: questionRecord.id, short_code_id: questionRecord.ticket_code };
      const code = `${parent.ticket_code}_${asked.short_code_id}`;
      await this.call('add_info', { short_code_id: asked.short_code_id,
        parent_question_short_code_id: parent.ticket_code, info: explanation, tz: 'UTC' });
      await this.humanReply(nestedScope, asked,
        'Understood, that fully answers my explanation question. No design change follows from it.');
      this.closure.nested.push({ ...asked, short_code_id: code });
    }
    await this.humanReply(scope, this.closure.withdrawn,
      'We are dropping both the repository migration trial and the competitor comparison. ' +
      'Those proposals are no longer relevant. The future storyboard design is still unfinished; ' +
      'keep its task and screenshot choice pending independently. The existing landing page contract stays unchanged.');
    this.closure.pending = await this.ask(this.closure.jobCode,
      'Which screenshot should the future storyboard use: a decision discussion or a task handoff?');

    this.incorporation = await this.createJob('Export link expiration',
      'Design only: update the current export-link contract from the primary human answer. ' +
      'All other behavior is settled. Do not implement or resolve the job.',
      '## Summary\nWhen the owner requests an export, return a download link that expires after 30 minutes. ' +
      'Keep the last successful export available if a later export fails.');
    this.incorporation.question = await this.ask(this.incorporation.jobCode,
      'How long should the export download link remain valid?');
    await this.humanReply({ ...scope, jobId: this.incorporation.job.investible.id },
      this.incorporation.question,
      'Use exactly 15 minutes, replacing the current 30-minute expiry. ' +
      'The owner-triggered export and last-successful-export failure behavior remain unchanged.');

    const ready = await pollFor(() => this.snapshotSemantic(), (state) =>
      state.closure.questions.length === 4 && state.incorporation.questions.length === 1 &&
      state.closure.questions.every((item) => item.version > 0) &&
      state.closure.capsules.length === 1 && state.incorporation.capsules.length === 1 &&
      state.closure.markdown.includes('Which screenshot') &&
      state.incorporation.markdown.includes('Use exactly 15 minutes'), 20, 1000);
    assert.strictEqual(ready.closure.questions.length, 4, 'Fixture questions did not converge');
  }

  targets() {
    return {
      closure: {
        jobCode: this.closure.jobCode,
        taskCode: this.closure.taskCode,
        closeCodes: [this.closure.withdrawn.short_code_id,
          ...this.closure.nested.map((item) => item.short_code_id)],
        pendingCode: this.closure.pending.short_code_id
      },
      incorporation: {
        jobCode: this.incorporation.jobCode,
        questionCode: this.incorporation.question.short_code_id,
        capsuleCode: this.incorporation.capsuleCode
      }
    };
  }

  async snapshotSemantic() {
    const [comments, nested, jobs] = await Promise.all([
      this.listComments(),
      this.listComments(this.nestedMarketId, this.nestedClient),
      this.listInvestibles()
    ]);
    const snapshot = {};
    for (const [phase, scope] of [['closure', this.closure], ['incorporation', this.incorporation]]) {
      const current = jobs.find((job) => job.investible.id === scope.job.investible.id);
      const info = current.market_infos.find((entry) => entry.market_id === this.marketId);
      const records = comments.filter((comment) => comment.investible_id === scope.job.investible.id);
      const questions = records.filter((comment) => comment.comment_type === 'QUESTION');
      if (phase === 'closure') {
        questions.push(...nested.filter((comment) => comment.comment_type === 'QUESTION').map((comment) =>
          ({ ...comment, ticket_code: `${this.closure.withdrawn.short_code_id}_${comment.ticket_code}` })));
      }
      const markdown = mcpText(await pollMcp(this.primaryConfiguration, this.uclusionToken,
        'get_job', { short_code_id: scope.jobCode, include_resolved: true, include_notes: true }));
      snapshot[phase] = {
        job: { code: scope.jobCode, resolved: Boolean(current.investible.resolved),
          stage_id: info.stage, assignments: info.assigned ?? info.assignments ?? [] },
        questions: questions.filter((item) => !item.deleted).map((item) => ({
          code: item.ticket_code, version: item.version, resolved: Boolean(item.resolved),
          delegated: Boolean(item.delegated), included_in_capsule: Boolean(item.included_in_capsule)
        })).sort((a, b) => a.code.localeCompare(b.code)),
        capsules: records.filter((item) => currentCapsule(item, scope.job.investible.id)).map((item) => ({
          code: item.ticket_code, body: item.body, version: item.version
        })),
        tasks: records.filter((item) => item.comment_type === 'TODO').map((item) => ({
          code: item.ticket_code, body: item.body, resolved: Boolean(item.resolved)
        })),
        task_capsules: records.filter((item) => item.pinned && item.associated_comment_id &&
          !item.resolved && !item.deleted).map((item) => item.ticket_code),
        markdown
      };
    }
    return snapshot;
  }

  preparePhase(session) {
    return this.createPhaseFixture(session, `Start ${this[session.phase].jobCode}`);
  }

  async snapshotAfterPhase() {
    // Reads converge through the same summary versions as the human client.
    return this.snapshotSemantic();
  }

  assertPhase(phase, before, after) {
    assertQuestionClosureState(phase, before, after, this.targets());
  }
}
