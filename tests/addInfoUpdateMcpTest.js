import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, pollFor } from './commonTestFunctions.js';

// S-all-322: exercise the public read -> expected-version write contract through
// the ordinary release gates. Writes are one-shot; only observation is polled.
export default function (adminConfiguration) {
  describe('#test add_info updates', () => {
    let accountClient;
    let accountToken;
    let adminClient;
    let marketId;
    let uclusionToken;
    let job;
    let jobCode;

    function result(raw) {
      const envelope = JSON.parse(raw);
      assert(envelope.result, `Missing MCP result: ${raw}`);
      return envelope.result;
    }

    async function call(name, args) {
      return result(await mcpCall(adminConfiguration, uclusionToken, name, args));
    }

    function success(response) {
      assert(!response.isError, JSON.stringify(response));
      assert(response.structuredContent, JSON.stringify(response));
      return response.structuredContent;
    }

    function text(response) {
      assert(!response.isError, JSON.stringify(response));
      return response.content.map((part) => part.text || '').join('\n');
    }

    function refusal(response, pattern) {
      assert.strictEqual(response.isError, true, JSON.stringify(response));
      if (pattern) assert.match(response.content.map((part) => part.text || '').join('\n'), pattern);
    }

    async function comments(targetMarketId = marketId, client = adminClient) {
      const response = await accountClient.summaries.versions(accountToken, [targetMarketId]);
      const entry = response.signatures?.find((item) => item.market_id === targetMarketId);
      const versions = new Map();
      (entry?.signatures || []).filter((signature) => signature.type === 'comment')
        .flatMap((signature) => signature.object_versions || [])
        .forEach((version) => versions.set(version.object_id_one,
          Math.max(versions.get(version.object_id_one) || 0, version.version)));
      if (!versions.size) return [];
      return client.investibles.getMarketComments(
        [...versions].map(([id, version]) => ({ id, version })));
    }

    async function persisted(info, targetMarketId = marketId, client = adminClient) {
      const rows = await pollFor(() => comments(targetMarketId, client), (items) =>
        items.some((item) => item.id === info.comment_id && item.version >= info.version));
      const row = rows.find((item) => item.id === info.comment_id);
      assert(row && row.version >= info.version, `Comment did not synchronize: ${JSON.stringify(info)}`);
      return row;
    }

    async function readInfo(info, marker, parentQuestion) {
      // Local codes are addressed through their question, never globally.
      const args = { short_code_id: parentQuestion || info.short_code_id, thread_only: true };
      const escapedCode = info.short_code_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // T-all-2547: a code inside a question renders with its question's code in front.
      const versionPattern = new RegExp(
        `(?:Note|Reply|Info) (?:\\S+_)?${escapedCode}<a[^\n]*\n(?:Note|Reply|Info) version: (\\d+)\\.`);
      const markdown = await pollFor(async () => text(await call('get_job', args)),
        (body) => body.includes(marker) && versionPattern.test(body));
      assert(markdown.includes(marker), `Missing info body: ${markdown}`);
      const match = markdown.match(versionPattern);
      assert(match, `Missing version beside ${info.short_code_id}: ${markdown}`);
      return Number(match[1]);
    }

    async function createInfo(target, marker, extra = {}) {
      const info = success(await call('add_info', {
        short_code_id: target, info: marker, tz: 'America/Los_Angeles', ...extra
      }));
      assert.strictEqual(info.status, 'created');
      assert(Number.isInteger(info.version) && info.version > 0);
      // S-all-331: a code inside a question is named Q-1_T-1, while its web UI link ends in T-1
      const qualified = extra.parent_question_short_code_id;
      if (qualified) {
        assert(info.short_code_id.startsWith(`${qualified}_`), `Expected a prefixed code: ${info.short_code_id}`);
      }
      assert(info.link.endsWith(`/${qualified ? info.short_code_id.slice(qualified.length + 1)
        : info.short_code_id}`));
      return info;
    }

    async function updateInfo(info, version, body, extra = {}) {
      return call('add_info', {
        update_info_short_code_id: info.short_code_id,
        update_info_version: version,
        info: body,
        tz: 'America/Los_Angeles',
        ...extra
      });
    }

    before(async function () {
      this.timeout(300000);
      if (!adminConfiguration.idToken) {
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      ({ client: accountClient, accountToken } = await loginUserToAccountAndGetToken(adminConfiguration));
      const created = await accountClient.markets.createMarket({
        name: 'Add info update integration', market_type: 'PLANNING'
      });
      marketId = created.market.id;
      await loginUserToMarketInvite(adminConfiguration, created.market.invite_capability);
      ({ client: adminClient } = await loginUserToMarketAndGetToken(adminConfiguration, marketId));
      const adminId = (await adminClient.users.get()).id;
      uclusionToken = await mcpLogin(adminConfiguration, adminClient, marketId);
      job = await adminClient.investibles.create({
        groupId: marketId, name: `Editable info ${randomUUID()}`,
        description: 'Exercise ordinary info corrections.', assignments: [adminId]
      });
      const marketInfo = job.market_infos.find((info) => info.market_id === marketId);
      jobCode = marketInfo.ticket_code || await pollFor(async () => {
        const rows = await adminClient.markets.getMarketInvestibles([{
          investible: { id: job.investible.id, version: 1 },
          market_infos: [{ id: marketInfo.id, version: 1 }]
        }]);
        return rows[0]?.market_infos.find((info) => info.market_id === marketId)?.ticket_code;
      }, Boolean);
      assert(jobCode);
      const ready = await pollFor(async () => {
        const summary = await accountClient.summaries.versions(accountToken, [marketId]);
        return summary.signatures?.find((entry) => entry.market_id === marketId)?.signatures
          ?.find((entry) => entry.type === 'market_capability')?.object_versions || [];
      }, (capabilities) => capabilities.length >= 2);
      assert(ready.length >= 2, 'The sole human and planning AI must be ready before one-shot writes');
    });

    it('edits every info form in place using versions read with the bodies', async function () {
      this.timeout(900000);
      const marker = randomUUID();
      const task = await adminClient.investibles.createComment(
        job.investible.id, marketId, `Info owner ${marker}`, null, 'TODO');
      const standalone = await adminClient.investibles.createComment(
        undefined, marketId, `Standalone thread ${marker}`, null, 'QUESTION');
      assert(task.ticket_code && standalone.ticket_code);
      const question = success(await call('ask_question', {
        job_id: jobCode, question: `Info option ${marker}`,
        options: [{ name: 'One option', description: 'Attach ordinary info here.' }],
        initial_vote: { new_option_index: 0, certainty: 4, reason: 'Exercise the option info form.' }
      }));
      const questionRows = await pollFor(comments,
        (rows) => rows.some((row) => row.id === question.comment_id && row.inline_market_id));
      const inlineMarketId = questionRows.find((row) => row.id === question.comment_id)?.inline_market_id;
      assert(inlineMarketId);
      const inlineLogin = await pollFor(
        () => loginUserToMarketAndGetToken(adminConfiguration, inlineMarketId), Boolean);
      const inlineClient = inlineLogin.client;
      const questionMarkdown = await pollFor(
        async () => text(await call('get_job', { short_code_id: question.short_code_id, thread_only: true })),
        (body) => /Option \S+_O-\d+<a/.test(body));
      const optionCode = questionMarkdown.match(/Option \S+_(O-\d+)<a/)?.[1];
      assert(optionCode);
      const parent = { parent_question_short_code_id: question.short_code_id };
      const note = await createInfo(jobCode, `Job note ${marker}`);
      const taskNote = await createInfo(task.ticket_code, `Task note ${marker}`);
      const reply = await createInfo(note.short_code_id, `Note reply ${marker}`);
      const standaloneReply = await createInfo(standalone.ticket_code, `Standalone reply ${marker}`);
      const optionInfo = await createInfo(optionCode, `Option info ${marker}`, parent);
      const optionReply = await createInfo(optionInfo.short_code_id, `Option reply ${marker}`, parent);
      // Reply creation updates its root asynchronously. Observe that change
      // before reading the versions used for the sequential success cases.
      for (const [root, child, targetMarket, client] of [
        [note, reply, marketId, adminClient],
        [optionInfo, optionReply, inlineMarketId, inlineClient]
      ]) {
        const rows = await pollFor(() => comments(targetMarket, client), (items) =>
          items.some((item) => item.id === root.comment_id && item.children?.includes(child.comment_id)));
        assert(rows.some((item) => item.id === root.comment_id && item.children?.includes(child.comment_id)));
      }
      const cases = [
        [note, `Job note ${marker}`], [taskNote, `Task note ${marker}`],
        [reply, `Note reply ${marker}`], [standaloneReply, `Standalone reply ${marker}`],
        [optionInfo, `Option info ${marker}`, parent, inlineMarketId, inlineClient],
        [optionReply, `Option reply ${marker}`, parent, inlineMarketId, inlineClient]
      ];
      for (const [info, original, extra = {}, targetMarket = marketId, client = adminClient] of cases) {
        const version = await readInfo(info, original, extra.parent_question_short_code_id);
        const before = await persisted({ ...info, version }, targetMarket, client);
        const corrected = `Corrected ${original}`;
        const updated = success(await updateInfo(info, version, corrected, extra));
        assert.strictEqual(updated.status, 'updated');
        assert.strictEqual(updated.comment_id, info.comment_id);
        assert.strictEqual(updated.short_code_id, info.short_code_id);
        assert.strictEqual(updated.link, info.link);
        assert(updated.version > version);
        const after = await persisted(updated, targetMarket, client);
        for (const field of ['created_by', 'market_id', 'investible_id', 'group_id',
          'associated_comment_id', 'reply_id', 'root_comment_id', 'comment_type', 'pinned', 'is_visible']) {
          assert.deepStrictEqual(after[field], before[field], `Update changed ${field}`);
        }
        assert(after.body.includes(corrected));
        const rereadVersion = await readInfo(updated, corrected, extra.parent_question_short_code_id);
        const unchanged = success(await updateInfo(updated, rereadVersion, corrected, extra));
        assert.strictEqual(unchanged.status, 'unchanged');
        assert.strictEqual(unchanged.version, rereadVersion);
        refusal(await updateInfo(updated, version, corrected, extra), /version|changed|reload/i);
      }
    });

    it('rejects protected targets and stale races without replacing other records', async function () {
      this.timeout(600000);
      const marker = randomUUID();
      const human = await createInfo(jobCode, `Human record ${marker}`, { for_human: true });
      refusal(await updateInfo(human, human.version, 'Must not overwrite human text'));
      const capsule = success(await call('set_design_capsule', {
        job_id: jobCode, capsule: `## Summary\nProtected capsule ${marker}`
      }));
      refusal(await updateInfo({ short_code_id: capsule.capsule_short_code_id },
        capsule.capsule_version, 'Must not overwrite a capsule'));
      const viewNote = success(await call('add_view_note', { note: `Standing instructions ${marker}` }));
      refusal(await updateInfo(viewNote, 1, 'Must not overwrite a view note'));
      const note = await createInfo(jobCode, `Race source ${marker}`);
      const version = await readInfo(note, `Race source ${marker}`);
      refusal(await updateInfo(note, version, 'Mixed mode', { short_code_id: jobCode }));
      refusal(await updateInfo(note, version, 'Human impersonation', { for_human: true }));
      const bodies = [`First racer ${marker}`, `Second racer ${marker}`];
      const responses = await Promise.all(bodies.map((body) => updateInfo(note, version, body)));
      assert.strictEqual(responses.filter((response) => !response.isError).length, 1,
        'Exactly one caller may replace the body read at this version');
      const winner = responses.findIndex((response) => !response.isError);
      refusal(responses[1 - winner], /version|changed|reload/i);
      const updated = success(responses[winner]);
      const stored = await persisted(updated);
      assert(stored.body.includes(bodies[winner]));
      assert(!stored.body.includes(bodies[1 - winner]));
      await readInfo(updated, bodies[winner]);
      await call('resolve', { short_code_id: note.short_code_id });
      const resolvedRows = await pollFor(comments,
        (rows) => rows.some((row) => row.id === note.comment_id && row.resolved));
      const resolved = resolvedRows.find((row) => row.id === note.comment_id);
      assert(resolved?.resolved);
      refusal(await updateInfo(note, resolved.version, 'Must not reopen resolved info'));
      const humanState = await persisted(human);
      assert(humanState.body.includes(`Human record ${marker}`));
    });

    it('stores a list written directly under a line and keeps the space before a linked code', async function () {
      this.timeout(300000);
      const marker = randomUUID();
      // T-all-2549: the demo's handoff note lost both of these on the way into storage.
      const info = await createInfo(jobCode,
        `**Why ${marker}**\n- **Policy-compliant.** ${jobCode} permits it.\n- Second reason.`);
      const expected = `**Why ${marker}**\n\n- **Policy-compliant.** [${jobCode}](#${jobCode}) permits it.\n`
        + '- Second reason.';
      const markdown = await pollFor(
        async () => text(await call('get_job', { short_code_id: info.short_code_id, thread_only: true })),
        (body) => body.includes(`Why ${marker}`));
      assert(markdown.includes(expected), `List or linked-code spacing was not stored as written: ${markdown}`);
    });
  });
}
