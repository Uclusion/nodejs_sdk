import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getMessages } from '../src/utils.js';
import { mcpCall, pollFor } from '../tests/commonTestFunctions.js';
import { pollMcp, SemanticDevFixture } from './semanticFixture.js';

export const NO_COMPLETION_CANDIDATES =
  'No completion-sweep candidates: no open dependency blocker matched the triggering work, ' +
  'and no unresolved job or bug became duplicate, obsolete, or in need of modification.';

const PHASES = Object.freeze(['declined', 'partial', 'full']);

function completionMenu(jobCode, taskFile) {
  return `${jobCode} has been reviewed. Choose completion actions:\n\n` +
    `1. Commit only its reviewed changes in the completion fixture repository:\n` +
    `   - \`${taskFile}\`.\n` +
    '2. Push only those commits.\n' +
    `3. Clear only the notifications produced by ${jobCode}.\n` +
    `4. Move ${jobCode} from Doable to Reviewable and immediately run its completion sweep.\n\n` +
    'Reply `all`, `none`, or numbers such as `1,2,4`. You may respond on this review ' +
    'or in the agent. Selected actions run in numeric order and stop at the first failure. ' +
    'Action 4 is indivisible.';
}

function marketInfo(job, marketId) {
  return job.market_infos.find((entry) => entry.market_id === marketId) ||
    job.market_infos[0];
}

function assignments(job, info) {
  return [...(
    info.assigned ?? info.assignments ?? job.investible.assignments ?? []
  )].sort();
}

function oneCommentCode(value, label) {
  const matches = [...new Set(String(value).match(
    /\b(?:C|R)-[A-Za-z0-9-]+\b/g
  ) || [])];
  assert.strictEqual(matches.length, 1,
    `${label} must return exactly one comment code: ${value}`);
  return matches[0];
}

function git(cwd, args, environment = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    windowsHide: true
  });
  assert.strictEqual(result.status, 0,
    `git ${args.join(' ')} failed in ${cwd}: ${result.error?.message || result.stderr}`);
  return result.stdout.trimEnd();
}

function isCurrentCapsule(comment, investibleId) {
  return comment.investible_id === investibleId &&
    comment.comment_type === 'REPORT' &&
    comment.notification_type === 'BLUE' &&
    comment.pinned === true &&
    !comment.associated_comment_id &&
    !comment.reply_id &&
    !comment.root_comment_id &&
    comment.is_sent === true &&
    comment.is_machine_only !== true &&
    comment.resolved !== true &&
    comment.deleted !== true;
}

function referencesCode(message, code) {
  return message?.is_highlighted !== false && typeof code === 'string' && code &&
    (String(message?.link || '').includes(`/${code}`) ||
      String(message?.type_object_id || '').includes(code));
}

function jobCore(snapshot) {
  return {
    stage_id: snapshot.stage_id,
    job_resolved: snapshot.job_resolved,
    assignments: snapshot.assignments,
    task_resolved: snapshot.task_resolved,
    question_codes: snapshot.question_codes,
    review_count: snapshot.review_reports.length,
    review_reply: snapshot.review_reply,
    package_records: snapshot.package_records,
    sweep_count: snapshot.sweep_notes.length,
    capsule_codes: snapshot.capsule_codes,
    target_notification_present: snapshot.target_notification_present,
    review_notification_present: snapshot.review_notification_present
  };
}

export class CompletionPackageDevFixture extends SemanticDevFixture {
  async initializeScenario() {
    this.reviewableStageId = this.stages.find((stage) =>
      stage.name === 'Reviewable')?.id;
    assert(this.reviewableStageId,
      'Completion-package fixture requires the Reviewable stage');
    this.completionPhases = {};
    this.phaseLocals = {};

    await this.createDecoyNotification();
    for (const phase of PHASES) {
      this.completionPhases[phase] = await this.createCompletionTarget(phase);
    }

    const ready = await pollFor(
      () => this.snapshotCompletion(),
      (state) => PHASES.every((phase) =>
        state.jobs[phase].stage_id === this.doableStageId &&
        state.jobs[phase].task_resolved === true &&
        state.jobs[phase].question_codes.length === 0 &&
        state.jobs[phase].review_reports.length === 1 &&
        state.jobs[phase].target_notification_present === true &&
        state.jobs[phase].review_notification_present === true) &&
        state.decoy_notification_present === true,
      20,
      1000
    );
    for (const phase of PHASES) {
      const snapshot = ready.jobs[phase];
      assert.strictEqual(snapshot.stage_id, this.doableStageId,
        `${phase} target must remain Doable after opening review`);
      assert.strictEqual(snapshot.task_resolved, true,
        `${phase} target must begin with its implementation task complete`);
      assert.deepStrictEqual(snapshot.question_codes, [],
        `${phase} target must not create a Uclusion completion question`);
      assert.strictEqual(snapshot.review_reports.length, 1,
        `${phase} target must begin with one auto-opened completion review`);
      assert(snapshot.review_reports[0].body.trimEnd().endsWith(
        this.completionPhases[phase].completionMenu),
        `${phase} completion review must end with the four-action menu`);
      assert.strictEqual(snapshot.target_notification_present, true,
        `${phase} target must begin with its nested unread notification`);
      assert.strictEqual(snapshot.review_notification_present, true,
        `${phase} target must begin with its review notification`);
    }
    assert.strictEqual(ready.decoy_notification_present, true,
      'Completion-package fixture must begin with its unrelated unread notification');
  }

  async createDecoyNotification() {
    this.decoyJob = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.reviewableStageId,
      assignments: [this.adminId],
      name: `Unrelated notification sentinel ${this.marker}`,
      description: 'An independent Reviewable sentinel used only to prove exact notification scope.'
    });
    this.decoyJobCode = await this.jobCodeFor(this.decoyJob);
    const task = await this.createTask(
      this.decoyJob,
      `Unrelated notification anchor ${this.marker}`
    );
    const anchor = await this.createHumanComment(
      this.decoyJob,
      `Unrelated notification reply anchor ${this.marker}`,
      task.id
    );
    const notificationParent = await this.createHumanComment(
      this.decoyJob,
      `Unrelated notification nested reply anchor ${this.marker}`,
      anchor.id
    );
    this.decoyNotificationCode = await this.createAiReplyNotification(
      notificationParent.ticket_code,
      `Unrelated notification reply ${this.marker}`,
      'Unrelated notification reply'
    );
    await this.waitForNotification(this.decoyJob.investible.id, this.decoyNotificationCode);
  }

  async createCompletionTarget(phase) {
    const outcome = {
      declined: 'produce an amber compatibility ledger',
      partial: 'produce a cobalt command inventory',
      full: 'produce a violet handoff manifest'
    }[phase];
    const taskFile = `completion-${phase}.txt`;
    const job = await this.adminClient.investibles.create({
      groupId: this.marketId,
      stageId: this.doableStageId,
      assignments: [this.adminId],
      name: `Completion package ${phase} ${this.marker}`,
      description: `The completed task must ${outcome}. Its code and approved testing are ` +
        'complete and testable. Its files, dependencies, assumptions, and actor outcome are ' +
        'independent from every other fixture job. Completion actions require the dedicated ' +
        'review-first completion menu.'
    });
    const jobCode = await this.jobCodeFor(job);
    assert(jobCode.startsWith('J-'), `${phase} completion target is missing a J- code`);
    const task = await this.createTask(job, `Completed ${phase} task ${this.marker}`);
    await pollMcp(this.primaryConfiguration, this.uclusionToken, 'resolve', {
      short_code_id: task.ticket_code
    });
    const resolvedTask = await pollFor(
      async () => (await this.listComments()).find((comment) => comment.id === task.id),
      (comment) => comment?.resolved === true,
      20,
      1000
    );
    assert.strictEqual(resolvedTask?.resolved, true,
      `${phase} completion task did not become durably resolved`);

    const capsuleMarker = `Completion ${phase} outcome ${this.marker}`;
    await pollMcp(this.primaryConfiguration, this.uclusionToken, 'set_design_capsule', {
      job_id: jobCode,
      capsule: `# ${capsuleMarker}\n\nThe primary actor receives the finished ${outcome}. ` +
        'The prepared task-owned file is the complete implementation. This outcome has no ' +
        'shared code, dependency, premise, or scope with another fixture job.'
    });
    const capsule = await pollFor(
      async () => (await this.listComments()).find((comment) =>
        comment.body?.includes(capsuleMarker) && isCurrentCapsule(comment, job.investible.id)),
      Boolean,
      20,
      1000
    );
    assert(capsule?.ticket_code?.startsWith('R-'),
      `${phase} completion target is missing its current R- capsule`);

    const menu = completionMenu(jobCode, taskFile);
    const reviewMarker = `Completion ${phase} review ${this.marker}`;
    await pollMcp(this.primaryConfiguration, this.uclusionToken, 'ask_for_review', {
      job_id: jobCode,
      report: `Implementation review: ${reviewMarker}\n\n` +
        `Current intent/design capsule: ${capsule.ticket_code}.\n\n` +
        '## Deltas\n\nNo implementation deltas.\n\n' +
        'The prepared task-owned fixture file is complete and testable.\n\n' +
        'AI product: Codex; model/version: AgentDev fixture; effort level: test.\n\n' +
        menu
    });
    const review = await pollFor(
      async () => (await this.listComments()).find((comment) =>
        comment.body?.includes(reviewMarker) &&
        comment.comment_type === 'REPORT' &&
        comment.notification_type !== 'BLUE'),
      Boolean,
      20,
      1000
    );
    assert(review?.ticket_code?.startsWith('R-'),
      `${phase} completion target is missing its auto-opened review`);
    await this.waitForNotification(job.investible.id, review.ticket_code);

    const notificationAnchor = await this.createHumanComment(
      job,
      `Nested ${phase} notification anchor ${this.marker}`,
      task.id
    );
    const notificationParent = await this.createHumanComment(
      job,
      `Nested ${phase} notification reply anchor ${this.marker}`,
      notificationAnchor.id
    );
    const notificationCode = await this.createAiReplyNotification(
      notificationParent.ticket_code,
      `Nested ${phase} notification reply ${this.marker}`,
      `${phase} nested notification reply`
    );
    await this.waitForNotification(job.investible.id, notificationCode);

    return {
      phase,
      job,
      jobCode,
      task,
      capsuleCode: capsule.ticket_code,
      notificationCode,
      taskFile,
      review,
      reviewCode: review.ticket_code,
      completionMenu: menu
    };
  }

  async createTask(job, body) {
    const created = await this.adminClient.investibles.createComment(
      job.investible.id,
      this.marketId,
      body,
      null,
      'TODO'
    );
    const task = created.ticket_code ? created : await this.findComment(body);
    assert(task?.ticket_code?.startsWith('T-'),
      `Completion-package task never received a T- code: ${body}`);
    return task;
  }

  async createHumanComment(job, body, parentCommentId = null) {
    const created = await this.adminClient.investibles.createComment(
      job.investible.id,
      this.marketId,
      body,
      parentCommentId
    );
    let comment = created;
    if (!comment.ticket_code && created.id) {
      comment = await pollFor(
        async () => (await this.listComments()).find((entry) => entry.id === created.id),
        Boolean,
        20,
        1000
      );
    } else if (!comment.ticket_code) {
      comment = await this.findComment(body);
    }
    assert(comment?.ticket_code?.startsWith('C-'),
      `Completion-package comment never received a C- code: ${body}`);
    assert.strictEqual(comment.created_by, this.adminId,
      'Completion-package fixture comments must be primary-human-authored');
    return comment;
  }

  async createAiReplyNotification(parentCode, body, label) {
    const result = await pollMcp(this.primaryConfiguration, this.uclusionToken, 'add_info', {
      short_code_id: parentCode,
      info: body,
      tz: 'America/Los_Angeles'
    });
    return oneCommentCode(result, label);
  }

  async waitForNotification(investibleId, code) {
    const notification = await pollFor(
      async () => ((await getMessages(this.primaryConfiguration)) || []).find((message) =>
        message.market_id === this.marketId &&
        message.investible_id === investibleId &&
        referencesCode(message, code)),
      Boolean,
      20,
      1000
    );
    assert(notification, `Unread notification for ${code} did not converge`);
    return notification;
  }

  configureExport(workspace) {
    const configPath = path.join(workspace, 'dev_uclusion.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.uclusionMDFileType = 'export';
    config.uclusionMDFolderPath = path.join(workspace, '.agent-dev-export');
    delete config.uclusionMDFilePath;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return config.uclusionMDFolderPath;
  }

  prepareRepository(phase, phaseFixture) {
    const target = this.completionPhases[phase];
    const workspace = phaseFixture.workspace;
    const gitDirectory = path.join(workspace, '.agent-dev-git');
    const gitEnvironment = {
      GIT_DIR: gitDirectory,
      GIT_WORK_TREE: workspace
    };
    const remotePath = path.join(workspace, '.agent-dev-origin.git');
    const exportPath = this.configureExport(workspace);
    const taskFile = target.taskFile;
    const unrelatedFile = `unrelated-${phase}.txt`;
    const baselineContent = `Prepared ${phase} artifact awaiting its task-owned result.\n`;
    const readyContent = `Completed by ${target.task.ticket_code}: ${phase} package artifact.\n`;
    const unrelatedBaselineContent = `Unrelated ${phase} baseline.\n`;
    const unrelatedReadyContent = `Unrelated ${phase} human change must remain uncommitted.\n`;
    fs.writeFileSync(path.join(workspace, '.gitignore'),
      '.agent-dev-export/\n.agent-dev-git/\n.agent-dev-origin.git/\n.cursor/\nclaude-mcp.json\n');
    fs.writeFileSync(path.join(workspace, taskFile), baselineContent);
    fs.writeFileSync(path.join(workspace, unrelatedFile), unrelatedBaselineContent);
    git(workspace, ['init', '--bare', '--initial-branch=main', remotePath]);
    git(workspace, ['init', '--initial-branch=main'], gitEnvironment);
    git(workspace, ['config', 'user.name', 'Agent DEV Fixture'], gitEnvironment);
    git(workspace, ['config', 'user.email', 'agent-dev-fixture@example.invalid'], gitEnvironment);
    git(workspace, ['add', '--all'], gitEnvironment);
    git(workspace, ['commit', '-m', 'Fixture baseline'], gitEnvironment);
    git(workspace, ['remote', 'add', 'origin', remotePath], gitEnvironment);
    git(workspace, ['push', '--set-upstream', 'origin', 'main'], gitEnvironment);
    const baselineHead = git(workspace, ['rev-parse', 'HEAD'], gitEnvironment);
    fs.writeFileSync(path.join(workspace, taskFile), readyContent);
    fs.writeFileSync(path.join(workspace, unrelatedFile), unrelatedReadyContent);
    this.phaseLocals[phase] = {
      workspace,
      gitDirectory,
      gitEnvironment,
      remotePath,
      exportPath,
      taskFile,
      unrelatedFile,
      baselineContent,
      readyContent,
      unrelatedBaselineContent,
      unrelatedReadyContent,
      baselineHead
    };
    phaseFixture.gitDirectory = gitDirectory;
    target.cliCommand = phaseFixture.expectedCliCommand;
    target.unrelatedFile = unrelatedFile;
    target.exportFile = path.join(exportPath, `${this.marketId}.md`);
    target.remotePath = remotePath;
  }

  async preparePhase(session) {
    const phase = session.target;
    assert(PHASES.includes(phase), `Unknown completion-package phase ${session.phase}`);
    const target = this.completionPhases[phase];
    assert(['all', 'none', '1'].includes(session.selection),
      `Unknown completion-package selection ${session.selection}`);
    assert(['agent', 'review'].includes(session.selectionSource),
      `Unknown completion-package response channel ${session.selectionSource}`);
    target.selection = session.selection;
    target.selectionSource = session.selectionSource;
    target.laterAgentSelection = session.laterAgentSelection || null;
    if (session.selectionSource === 'review') {
      assert(!target.reviewReply,
        `${phase} completion review already has a prepared first reply`);
      const createdReply = await this.createHumanComment(
        target.job,
        session.selection,
        target.review.id
      );
      target.reviewReply = await pollFor(
        async () => (await this.listComments()).find((comment) =>
          comment.id === createdReply.id),
        Boolean,
        20,
        1000
      );
    }
    const expectedEvent = session.laterAgentSelection || session.selection;
    const phaseFixture = this.createPhaseFixture(session, expectedEvent);
    this.prepareRepository(phase, phaseFixture);
    this.activePhase = phase;
    phaseFixture.snapshot = () => this.snapshotCompletion(phase);
    return phaseFixture;
  }

  targets() {
    return Object.fromEntries(PHASES.map((phase) => {
      const target = this.completionPhases?.[phase];
      return [phase, target ? {
        jobCode: target.jobCode,
        taskCode: target.task.ticket_code,
        capsuleCode: target.capsuleCode,
        notificationCode: target.notificationCode,
        reviewCode: target.reviewCode,
        reviewReplyCode: target.reviewReply?.ticket_code || null,
        selection: target.selection,
        selectionSource: target.selectionSource,
        laterAgentSelection: target.laterAgentSelection,
        completionMenu: target.completionMenu,
        cliCommand: target.cliCommand,
        taskFile: target.taskFile,
        unrelatedFile: target.unrelatedFile,
        exportFile: target.exportFile,
        remotePath: target.remotePath,
        noCandidates: NO_COMPLETION_CANDIDATES
      } : null];
    }));
  }

  async currentJob(job) {
    const info = marketInfo(job, this.marketId);
    const [current] = await this.adminClient.markets.getMarketInvestibles([{
      investible: { id: job.investible.id, version: 1 },
      market_infos: [{ id: info.id, version: 1 }]
    }]);
    return current;
  }

  gitSnapshot(phase) {
    const local = this.phaseLocals[phase];
    if (!local) {
      return null;
    }
    const head = git(local.workspace, ['rev-parse', 'HEAD'], local.gitEnvironment);
    const originHead = git(local.workspace, [
      '--git-dir', local.remotePath,
      'rev-parse', 'refs/heads/main'
    ]);
    const changedPaths = head === local.baselineHead ? [] : git(local.workspace, [
      'diff', '--name-only', local.baselineHead, head
    ], local.gitEnvironment).split('\n').filter(Boolean);
    const exportFile = path.join(local.exportPath, `${this.marketId}.md`);
    return {
      baseline_head: local.baselineHead,
      head,
      origin_head: originHead,
      remotes: git(local.workspace, ['remote'], local.gitEnvironment).split('\n').filter(Boolean),
      origin_url: git(local.workspace, ['remote', 'get-url', 'origin'], local.gitEnvironment),
      origin_refs: git(local.workspace, [
        '--git-dir', local.remotePath,
        'for-each-ref', '--format=%(refname)', 'refs/heads'
      ]).split('\n').filter(Boolean),
      commit_count: Number(git(local.workspace, [
        'rev-list', '--count', `${local.baselineHead}..${head}`
      ], local.gitEnvironment)),
      commit_subject: git(local.workspace, ['log', '-1', '--format=%s'], local.gitEnvironment),
      status: git(local.workspace, ['status', '--short'], local.gitEnvironment)
        .split('\n').filter(Boolean),
      changed_paths: changedPaths,
      task_file: local.taskFile,
      working_content: fs.readFileSync(
        path.join(local.workspace, local.taskFile),
        'utf8'
      ).trimEnd(),
      committed_content: git(
        local.workspace,
        ['show', `HEAD:${local.taskFile}`],
        local.gitEnvironment
      ),
      ready_content: local.readyContent.trimEnd(),
      unrelated_file: local.unrelatedFile,
      unrelated_working_content: fs.readFileSync(
        path.join(local.workspace, local.unrelatedFile),
        'utf8'
      ).trimEnd(),
      unrelated_committed_content: git(
        local.workspace,
        ['show', `HEAD:${local.unrelatedFile}`],
        local.gitEnvironment
      ),
      unrelated_ready_content: local.unrelatedReadyContent.trimEnd(),
      unrelated_baseline_content: local.unrelatedBaselineContent.trimEnd(),
      export_file: exportFile,
      export_exists: fs.existsSync(exportFile)
    };
  }

  async snapshotCompletion(activePhase = this.activePhase) {
    const [comments, messages, ...currentJobs] = await Promise.all([
      this.listComments(),
      getMessages(this.primaryConfiguration),
      ...PHASES.map((phase) => this.currentJob(this.completionPhases[phase].job))
    ]);
    const inbox = (messages || []).filter((message) => message.market_id === this.marketId);
    const jobs = {};
    PHASES.forEach((phase, index) => {
      const target = this.completionPhases[phase];
      const current = currentJobs[index];
      const info = marketInfo(current, this.marketId);
      const task = comments.find((comment) => comment.id === target.task.id);
      const jobComments = comments.filter((comment) =>
        comment.investible_id === target.job.investible.id && !comment.deleted);
      const reviewReports = jobComments.filter((comment) =>
        comment.comment_type === 'REPORT' && comment.notification_type !== 'BLUE' &&
        comment.created_by && ![this.adminId, this.advisoryId].includes(comment.created_by));
      const reviewCodes = reviewReports.map((comment) => comment.ticket_code).filter(Boolean);
      if (reviewCodes.length === 1) {
        target.reviewCode = reviewCodes[0];
      }
      const reviewReply = target.reviewReply
        ? jobComments.find((comment) => comment.id === target.reviewReply.id)
        : null;
      const review = reviewReports.find((comment) => comment.id === target.review.id);
      const packageRecords = jobComments.filter((comment) =>
        comment.id !== review?.id &&
        comment.created_by &&
        ![this.adminId, this.advisoryId].includes(comment.created_by) &&
        (comment.reply_id === review?.id || comment.root_comment_id === review?.id));
      jobs[phase] = {
        job_code: target.jobCode,
        stage_id: info.stage,
        job_resolved: current.investible.resolved === true,
        assignments: assignments(current, info),
        task_code: target.task.ticket_code,
        task_resolved: task?.resolved === true,
        question_codes: jobComments.filter((comment) =>
          comment.comment_type === 'QUESTION'
        ).map((comment) => comment.ticket_code).filter(Boolean).sort(),
        capsule_codes: jobComments.filter((comment) =>
          isCurrentCapsule(comment, target.job.investible.id)
        ).map((comment) => comment.ticket_code).sort(),
        review_reports: reviewReports.map((comment) => ({
          id: comment.id,
          code: comment.ticket_code,
          body: comment.body || ''
        })),
        review_reply: reviewReply ? {
          id: reviewReply.id,
          code: reviewReply.ticket_code,
          body: reviewReply.body || '',
          created_by: reviewReply.created_by
        } : null,
        package_records: packageRecords.map((comment) => ({
          id: comment.id,
          code: comment.ticket_code,
          body: comment.body || '',
          reply_id: comment.reply_id || null,
          root_comment_id: comment.root_comment_id || null,
          created_by: comment.created_by
        })),
        sweep_notes: jobComments.filter((comment) =>
          comment.body?.includes(NO_COMPLETION_CANDIDATES)
        ).map((comment) => ({ code: comment.ticket_code, body: comment.body })),
        target_notification_present: inbox.some((message) =>
          referencesCode(message, target.notificationCode)),
        review_notification_present: reviewReports.some((report) =>
          inbox.some((message) => message.is_highlighted !== false &&
            (referencesCode(message, report.code) ||
              String(message.type_object_id || '').includes(report.id))))
      };
    });
    return {
      jobs,
      decoy_notification_present: inbox.some((message) =>
        referencesCode(message, this.decoyNotificationCode)),
      git: activePhase ? this.gitSnapshot(activePhase) : null
    };
  }

  async snapshotSemantic() {
    return this.snapshotCompletion(this.activePhase);
  }

  async snapshotAfterPhase(phaseName) {
    const phase = phaseName.replace('completion-package-', '');
    const settled = (state) => {
      const job = state.jobs[phase];
      if (phase === 'declined') {
        return job.stage_id === this.doableStageId &&
          job.package_records.length === 1;
      }
      if (phase === 'partial') {
        return job.stage_id === this.doableStageId &&
          job.review_reports.length === 1 &&
          job.review_reports[0].code?.startsWith('R-') &&
          job.review_notification_present === true &&
          job.package_records.length === 1 &&
          state.git?.commit_count === 1;
      }
      return job.stage_id === this.reviewableStageId &&
        job.review_reports.length === 1 &&
        job.review_reports[0].code?.startsWith('R-') &&
        job.sweep_notes.length === 1 &&
        job.target_notification_present === false &&
        job.review_notification_present === false &&
        job.package_records.length === 2 &&
        state.decoy_notification_present === true &&
        state.git?.head === state.git?.origin_head &&
        state.git?.export_exists === true;
    };
    return pollFor(
      () => this.snapshotCompletion(phase),
      settled,
      20,
      3000
    );
  }

  assertPhase(phaseName, before, after) {
    const phase = phaseName.replace('completion-package-', '');
    const target = this.completionPhases[phase];
    const beforeJob = before.jobs[phase];
    const afterJob = after.jobs[phase];
    assert(target, `Unknown completion-package assertion phase ${phaseName}`);
    assert.strictEqual(beforeJob.stage_id, this.doableStageId,
      `${phase} phase must begin Doable after its review-first prompt`);
    assert.deepStrictEqual(beforeJob.question_codes, [],
      `${phase} phase must begin without a Uclusion package question`);
    assert.strictEqual(beforeJob.task_resolved, true,
      `${phase} phase must begin with its exact task complete`);
    assert.deepStrictEqual(beforeJob.capsule_codes, [target.capsuleCode],
      `${phase} phase must begin with one exact current capsule`);
    assert.strictEqual(beforeJob.review_reports.length, 1,
      `${phase} phase must begin with one auto-opened review`);
    assert.strictEqual(beforeJob.review_reports[0].code, target.reviewCode,
      `${phase} phase must begin with the exact auto-opened review`);
    assert(beforeJob.review_reports[0].body.trimEnd().endsWith(target.completionMenu),
      `${phase} phase review must end with its exact four-action menu`);
    assert(beforeJob.review_reports[0].body.includes(target.capsuleCode),
      `${phase} phase review must name its current capsule`);
    assert.match(beforeJob.review_reports[0].body, /\bDeltas\b/i,
      `${phase} phase review must retain the capsule-delta report shape`);
    const expectedReviewReply = target.reviewReply ? {
      id: target.reviewReply.id,
      code: target.reviewReply.ticket_code,
      body: target.reviewReply.body || '',
      created_by: this.adminId
    } : null;
    assert.deepStrictEqual(beforeJob.review_reply, expectedReviewReply,
      `${phase} phase must begin with only its configured review-channel reply`);
    if (expectedReviewReply) {
      assert(beforeJob.review_reply.body.includes(target.selection),
        `${phase} phase review reply must contain its first valid selection`);
    }
    assert.deepStrictEqual(beforeJob.package_records, [],
      `${phase} phase must begin before any AI package-state record`);
    assert.strictEqual(beforeJob.target_notification_present, true,
      `${phase} phase must begin with its nested unread notification`);
    assert.strictEqual(beforeJob.review_notification_present, true,
      `${phase} phase must begin with its review notification`);
    assert.deepStrictEqual(afterJob.question_codes, [],
      `${phase} phase must not persist its completion selection as a Uclusion question`);
    assert.strictEqual(afterJob.task_resolved, true,
      `${phase} phase must preserve its resolved implementation task`);
    assert.strictEqual(afterJob.job_resolved, false,
      `${phase} phase must not resolve the enclosing job`);
    assert.deepStrictEqual(afterJob.assignments, [this.adminId],
      `${phase} phase must preserve the exact human assignment`);
    assert.deepStrictEqual(afterJob.capsule_codes, [target.capsuleCode],
      `${phase} phase must preserve its exact current capsule`);
    assert.strictEqual(afterJob.review_reports.length, 1,
      `${phase} package must preserve exactly one review`);
    assert.deepStrictEqual(afterJob.review_reports[0], beforeJob.review_reports[0],
      `${phase} package must not replace or update its auto-opened review`);
    assert.deepStrictEqual(afterJob.review_reply, beforeJob.review_reply,
      `${phase} package must preserve its first review-channel reply`);
    assert.strictEqual(after.decoy_notification_present, true,
      `${phase} phase must preserve the unrelated unread notification`);
    assert.deepStrictEqual(after.git.remotes, ['origin'],
      `${phase} package must retain only its disposable origin`);
    assert.strictEqual(after.git.origin_url, target.remotePath,
      `${phase} package must retain the exact local bare origin`);

    for (const otherPhase of PHASES.filter((candidate) => candidate !== phase)) {
      assert.deepStrictEqual(jobCore(after.jobs[otherPhase]), jobCore(before.jobs[otherPhase]),
        `${phase} phase changed unrelated ${otherPhase} completion state`);
    }

    const expectedDirty = [
      ` M ${target.taskFile}`,
      ` M ${target.unrelatedFile}`
    ];
    const expectedUnrelatedDirty = [` M ${target.unrelatedFile}`];
    assert.deepStrictEqual(before.git.status, expectedDirty,
      `${phase} phase must begin with task-owned and unrelated prepared diffs`);
    assert.strictEqual(after.git.unrelated_working_content, after.git.unrelated_ready_content,
      `${phase} package must preserve the unrelated working-tree content`);
    assert.strictEqual(
      after.git.unrelated_committed_content,
      after.git.unrelated_baseline_content,
      `${phase} package must leave the unrelated change uncommitted`
    );
    if (phase === 'declined') {
      assert.strictEqual(afterJob.stage_id, this.doableStageId,
        'Declined package must leave the exact job Doable');
      assert.strictEqual(afterJob.review_reports[0].code, target.reviewCode,
        'Declined package must keep the review that preceded its none reply');
      assert.strictEqual(afterJob.sweep_notes.length, 0,
        'Declined package must not record a completion sweep');
      assert.strictEqual(afterJob.target_notification_present, true,
        'Declined package must preserve the exact job notification');
      assert.strictEqual(afterJob.review_notification_present, true,
        'Declined package must preserve the completion review notification');
      assert.strictEqual(afterJob.package_records.length, 1,
        'Declined package must durably acknowledge its terminal chat selection once');
      assert.strictEqual(afterJob.package_records[0].reply_id, target.review.id,
        'Declined chat acknowledgement must be recorded on the exact review');
      assert.deepStrictEqual(after.git.status, expectedDirty,
        'Declined package must preserve both prepared diffs');
      assert.strictEqual(after.git.working_content, after.git.ready_content,
        'Declined package must preserve the prepared task-owned content');
      assert.strictEqual(after.git.head, after.git.baseline_head,
        'Declined package must not commit');
      assert.strictEqual(after.git.origin_head, after.git.baseline_head,
        'Declined package must not push');
      return;
    }

    assert(afterJob.review_reports[0].code?.startsWith('R-'),
      `${phase} completion review must expose its durable R- code`);
    assert.deepStrictEqual(after.git.status, expectedUnrelatedDirty,
      `${phase} package must commit only its task-owned diff`);
    assert.strictEqual(after.git.commit_count, 1,
      `${phase} package must create exactly one task-owned commit`);
    assert(after.git.commit_subject.startsWith(target.task.ticket_code),
      `${phase} commit subject must begin with the canonical task code`);
    assert.deepStrictEqual(after.git.changed_paths, [target.taskFile],
      `${phase} commit must contain only the prepared task-owned file`);
    assert.strictEqual(after.git.committed_content, after.git.ready_content,
      `${phase} commit must preserve the prepared task-owned content`);
    assert.deepStrictEqual(after.git.origin_refs, ['refs/heads/main'],
      `${phase} package must not create or push another branch`);

    if (phase === 'partial') {
      assert.strictEqual(afterJob.stage_id, this.doableStageId,
        'Partial package must keep the exact job Doable');
      assert.strictEqual(afterJob.sweep_notes.length, 0,
        'Partial package must not record a completion sweep');
      assert.strictEqual(afterJob.target_notification_present, true,
        'Partial package must preserve the exact job notification');
      assert.strictEqual(afterJob.review_notification_present, true,
        'Partial package must preserve the completion review notification');
      assert.strictEqual(afterJob.package_records.length, 1,
        'Partial package must record one terminal status on its human review reply');
      assert.strictEqual(afterJob.package_records[0].reply_id, target.reviewReply.id,
        'Partial terminal status must use the human review reply as its state root');
      assert.strictEqual(after.git.origin_head, after.git.baseline_head,
        'Partial package must not push its commit-only selection');
      return;
    }

    assert.strictEqual(afterJob.stage_id, this.reviewableStageId,
      'Full package must move the exact job to Reviewable');
    assert.strictEqual(afterJob.target_notification_present, false,
      'Full package must clear its identified nested notification');
    assert.strictEqual(afterJob.review_notification_present, false,
      'Full package must clear the completion review notification');
    assert.strictEqual(afterJob.sweep_notes.length, 1,
      'Full package must record exactly one completion sweep result');
    assert.strictEqual(afterJob.sweep_notes[0].body.includes(NO_COMPLETION_CANDIDATES), true,
      'Full package must record the explicit no-candidate completion result');
    assert.strictEqual(afterJob.package_records.length, 2,
      'Full package must retain one chat acknowledgement and one terminal status');
    const acceptedSelection = afterJob.package_records.find((record) =>
      record.reply_id === target.review.id);
    assert(acceptedSelection,
      'Full chat selection must be durably acknowledged on the exact review');
    assert(afterJob.package_records.some((record) =>
      record.reply_id === acceptedSelection.id),
    'Full terminal status must reply to its accepted chat-selection record');
    assert.strictEqual(after.git.origin_head, after.git.head,
      'Full package must push its exact task-owned commit');
    assert.strictEqual(after.git.export_exists, true,
      'Full package must write the completion export to its configured ignored directory');
  }
}
