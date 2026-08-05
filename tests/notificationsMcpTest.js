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
  describe('#test notifications MCP integration', () => {
    let accountClient;
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
      const result = await accountClient.markets.createMarket({
        name: 'Notifications MCP integration',
        market_type: 'PLANNING'
      });
      marketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const marketLogin = await loginUserToMarketAndGetToken(adminConfiguration, marketId);
      adminClient = marketLogin.client;
      // This is the same market-scoped token used by the CLI proxy.
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

    function getNotifications() {
      return mcpCall(adminConfiguration, uclusionToken, 'get_notifications', {});
    }

    function parseMcpToolResult(stringifiedEnvelope) {
      const toolResult = JSON.parse(stringifiedEnvelope).result;
      return toolResult.structuredContent || JSON.parse(toolResult.content[0].text);
    }

    // mcpCall returns the stringified JSON-RPC envelope, so the markdown's newlines
    // arrive as literal backslash-n escapes.
    function linesAbout(stringifiedResult, ticketCodes) {
      return stringifiedResult.split('\\n')
        .filter((line) => ticketCodes.some((code) => line.includes(code)));
    }

    function hasUnreadLine(stringifiedResult, ticketCodes) {
      return linesAbout(stringifiedResult, ticketCodes).some((line) => !line.includes(', read**'));
    }

    it('lists an AI reply notification and clears it by job short code', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Notifications inbox ${marker}`,
        description: 'Job whose question thread collects the tracked AI reply notification.'
      });
      const jobTicketCode = await getTicketCode(job);
      // J-all-385: AI activity notifies like anyone else's, marked AI_GENERATED so email is
      // withheld. An AI reply to a human-authored comment is the deep case that could get
      // buried in the agent's chat window.
      const question = await adminClient.investibles.createComment(job.investible.id, marketId,
        `Does this land in the human inbox ${marker}?`, null, 'QUESTION');
      assert(question.ticket_code, `Question ticket code missing: ${JSON.stringify(question)}`);
      const replied = await pollMcp('add_info', {
        short_code_id: question.ticket_code,
        info: `AI reply that must generate a tracked notification ${marker}.`
      });
      const replyMatch = replied.match(/Added info with id (\S+) and link/);
      assert(replyMatch, `MCP add_info response wrong: ${replied}`);
      const replyTicketCode = replyMatch[1];
      const ticketCodes = [replyTicketCode];
      const expectedReplyLink = `/${marketId}/${replyTicketCode}`;

      const rawReplyNotification = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) =>
          message.market_id === marketId &&
          message.investible_id === job.investible.id &&
          message.alert_type === 'AI_GENERATED' &&
          message.type_object_id?.startsWith('UNREAD_REPLY_'));
      }, (notification) => notification);
      assert(rawReplyNotification,
        `Raw AI reply notification missing for ${replyTicketCode}`);
      assert.strictEqual(rawReplyNotification.link, expectedReplyLink,
        `AI reply notification should store its canonical short-code link: ${
          JSON.stringify(rawReplyNotification)}`);

      const inbox = await pollFor(getNotifications,
        (markdown) => markdown.includes(replyTicketCode));
      assert(inbox.includes(replyTicketCode),
        `get_notifications should list the AI reply notification ${replyTicketCode}: ${inbox}`);
      assert(!inbox.includes('No notifications.'),
        `Inbox should not render empty once the reply notification exists: ${inbox}`);
      // B-all-516: inbox lines carry the ticket path (often as an absolute UI URL
      // `http://host/{marketId}/{ticketCode}`). Accept that or a bare ` — C-…`
      // form; only the legacy `/dialog/…` UUID link is wrong.
      const ticketPath = `/${marketId}/${replyTicketCode}`;
      const replyLine = linesAbout(inbox, ticketCodes)
        .find((line) => ticketCodes.some((code) => line.includes(code)));
      assert(replyLine,
        `get_notifications should list the reply notification ${replyTicketCode}: ${inbox}`);
      assert(
        replyLine.includes(ticketPath) || replyLine.includes(` — ${replyTicketCode}`),
        `get_notifications should render the ticket path or bare code for ${replyTicketCode}: ${replyLine}`
      );
      assert(!replyLine.includes('/dialog/'),
        `Reply notification should not fall back to an internal UUID dialog link: ${replyLine}`);

      // Clearing by the JOB short code must catch the reply's notification through its
      // investible id — the object the agent finished, not the individual comment.
      const cleared = await mcpCall(adminConfiguration, uclusionToken, 'clear_notifications', {
        short_code_id: jobTicketCode
      });
      assert(cleared.includes('Cleared'), `clear_notifications response wrong: ${cleared}`);
      assert(!cleared.includes('Cleared 0 '),
        `clear_notifications should match at least one notification: ${cleared}`);

      // Cleared means removed (unread types) or marked read (persistent types); either way no
      // unread line about the reply may remain.
      const after = await pollFor(getNotifications,
        (markdown) => !hasUnreadLine(markdown, ticketCodes));
      assert(!hasUnreadLine(after, ticketCodes),
        `No unread notification should remain about ${ticketCodes} after the clear: ${after}`);
    }).timeout(600000);

    it('notifies the assignee with AI_GENERATED when the AI asks a first-level question', async () => {
      const marker = randomUUID();
      const user = await adminClient.users.get();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `AI question inbox ${marker}`,
        description: 'Job whose AI-authored first-level question must land in the assignee inbox.',
        assignments: [user.id]
      });
      const jobTicketCode = await getTicketCode(job);
      // J-all-385: first-level AI comments were deliberately silent before multi-agent
      // support; now they notify the assignee, marked AI_GENERATED so email stays withheld.
      const asked = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: `Does this first level AI question land in the inbox ${marker}?`
      });
      assert(asked.includes('Added question'), `MCP ask_question response wrong: ${asked}`);
      const questionNotification = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.find((message) =>
          message.market_id === marketId &&
          message.investible_id === job.investible.id &&
          message.alert_type === 'AI_GENERATED' &&
          message.type_object_id?.startsWith('UNREAD_COMMENT_'));
      }, (notification) => notification);
      assert(questionNotification,
        'AI first-level question should notify the assignee with AI_GENERATED');
    }).timeout(600000);

    it('marks find_work items auto_take when the view opts in', async () => {
      const marker = randomUUID();
      const user = await adminClient.users.get();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Auto take ${marker}`,
        description: 'Job that find_work must annotate once its view opts in to auto take.',
        assignments: [user.id]
      });
      const jobTicketCode = await getTicketCode(job);
      // C-all-1373: the view-level opt-in annotates that view's items so agents take the
      // next available instead of asking.
      const updated = await adminClient.markets.updateGroup(marketId, { ai_auto_take: true });
      assert(updated.ai_auto_take === true, 'Group update should persist ai_auto_take');
      try {
        const found = await pollFor(
          () => pollMcp('find_work', {}),
          (result) => parseMcpToolResult(result).work_list.some((item) =>
            item.short_code_id === jobTicketCode && item.auto_take === true));
        const findWork = parseMcpToolResult(found);
        const target = findWork.work_list.find((item) => item.short_code_id === jobTicketCode);
        assert(target, `find_work should list ${jobTicketCode}: ${found}`);
        assert.strictEqual(target.auto_take, true,
          `find_work should mark ${jobTicketCode} auto_take: ${found}`);
        assert(findWork.auto_take_directions,
          `find_work should carry auto_take_directions when auto_take items exist: ${found}`);
        assert(findWork.auto_take_directions.includes(
          'same turn that produced this list') && findWork.auto_take_directions.includes(
          'call get_job for the FIRST auto_take item'),
          `auto_take_directions should require loading the target in the same turn: ${found}`);
        assert(findWork.auto_take_directions.includes(
          'initial auto-take turn or any later turn working that item'),
          `auto_take_directions should persist the handoff rule across the work lane: ${found}`);
        assert(findWork.auto_take_directions.includes('otherwise use add_info on the active item'),
          `auto_take_directions should require a durable fallback handoff: ${found}`);
        assert(findWork.auto_take_directions.includes(
          'Chat may mirror that handoff, but must never be its only copy'),
          `auto_take_directions must forbid chat-only handoffs: ${found}`);
      } finally {
        await adminClient.markets.updateGroup(marketId, { ai_auto_take: false });
      }
    }).timeout(600000);

    it('clears nothing for an object without notifications', async () => {
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Quiet job ${randomUUID()}`,
        description: 'A job the human created themselves generates no self-notification.'
      });
      const jobTicketCode = await getTicketCode(job);
      const cleared = await pollMcp('clear_notifications', { short_code_id: jobTicketCode });
      assert(cleared.includes('Cleared 0 '),
        `clear_notifications must not touch unrelated notifications: ${cleared}`);
    }).timeout(300000);
  });
}
