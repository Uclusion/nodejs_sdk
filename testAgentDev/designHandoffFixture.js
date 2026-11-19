import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { mcpCall, pollFor } from '../tests/commonTestFunctions.js';
import { SemanticDevFixture, pollMcp } from './semanticFixture.js';

export const CARD_TASKS = Object.freeze([
  { name: 'Cedar card', file: 'cards/cedar.txt', content: 'Cedar grows slowly.\n' },
  { name: 'Harbor card', file: 'cards/harbor.txt', content: 'The harbor is quiet.\n' },
  { name: 'Orchard card', file: 'cards/orchard.txt', content: 'The orchard is green.\n' }
]);

export class DesignHandoffDevFixture extends SemanticDevFixture {
  async initializeScenario() {
    this.job = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.approvableStageId,
      assignments: [this.adminId],
      name: `Three text cards ${this.marker}`,
      description: 'Deliver the three text cards described by the tasks. Each card is a ' +
        'separate UTF-8 plain-text file with one trailing newline. There is no index, ' +
        'shared application code, dependency, build step or other deliverable. The exact ' +
        'filenames and sentences in the tasks are settled human requirements.'
    });
    this.jobCode = await this.jobCodeFor(this.job);
    this.tasks = [];
    for (const card of CARD_TASKS) {
      const body = `${card.name}: create ${card.file} containing exactly ` +
        `${JSON.stringify(card.content)} (JSON string notation specifies the trailing newline).`;
      await this.adminClient.investibles.createComment(
        this.job.investible.id, this.marketId, body, null, 'TODO');
      const task = await this.findComment(body);
      assert(task.ticket_code?.startsWith('T-'), 'Card task has no canonical code');
      this.tasks.push({ ...card, id: task.id, code: task.ticket_code });
    }
    // Settle the independent value vote before the run, as in stage-authorization.
    // The fixture remains Approvable: a design alone is not a stage instruction.
    await mcpCall(this.primaryConfiguration, this.uclusionToken, 'approve_job_or_option', {
      job_or_option_id: this.jobCode, certainty: 5,
      reason: 'The three specified text cards have a clear bounded value premise.'
    });
    const ready = await pollFor(() => this.snapshotSemantic(), (state) =>
      state.stage === this.approvableStageId && state.tasks.length === 3, 20, 1000);
    assert.strictEqual(ready.stage, this.approvableStageId);
  }

  prepareWorkspace(session) {
    this.local = this.createPhaseFixture(session, `Start ${this.jobCode}`);
    return this.local;
  }

  async snapshotSemantic() {
    const [jobs, comments, markdown] = await Promise.all([
      this.listInvestibles(), this.listComments(),
      pollMcp(this.primaryConfiguration, this.uclusionToken, 'get_job', {
        short_code_id: this.jobCode
      })
    ]);
    const job = jobs.find((item) => item.investible.id === this.job.investible.id);
    const info = job?.market_infos.find((item) => item.market_id === this.marketId);
    const records = comments.filter((item) => item.investible_id === this.job.investible.id);
    return {
      stage: info?.stage, job_code: this.jobCode, markdown, records,
      tasks: this.tasks.map((task) => ({ ...task,
        resolved: Boolean(comments.find((item) => item.id === task.id)?.resolved),
        associated_record_ids: records.filter((item) => item.associated_comment_id === task.id)
          .map((item) => item.id),
        actual_content: this.local && fs.existsSync(path.join(this.local.workspace, task.file))
          ? fs.readFileSync(path.join(this.local.workspace, task.file), 'utf8') : null
      }))
    };
  }

  async allowImplementation() {
    await this.adminClient.investibles.stateChange(this.job.investible.id, {
      current_stage_id: this.approvableStageId, stage_id: this.doableStageId
    });
    const state = await pollFor(() => this.snapshotSemantic(), (value) =>
      value.stage === this.doableStageId, 20, 1000);
    assert.strictEqual(state.stage, this.doableStageId, 'Human fixture stage change did not converge');
    return state;
  }
}
