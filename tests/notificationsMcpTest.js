import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, pollFor as pollForRead, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration, userConfiguration) {
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
        info: `AI reply that must generate a tracked notification ${marker}.`,
        tz: 'America/Los_Angeles'
      });
      const replyTicketCode = JSON.parse(replied).result?.structuredContent?.short_code_id;
      assert(replyTicketCode, `MCP add_info response wrong: ${replied}`);
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
      assert(!inbox.includes('/dialog/'),
        `Reply notification should not fall back to an internal UUID dialog link: ${inbox}`);

      // Clearing by the JOB short code must catch the reply's notification through its
      // investible id — the object the agent finished, not the individual comment.
      const cleared = await mcpCall(adminConfiguration, uclusionToken, 'clear_notifications', {
        short_code_id: jobTicketCode
      });
      assert.notStrictEqual(JSON.parse(cleared).result.isError, true,
        `clear_notifications should succeed: ${cleared}`);
      const remaining = await pollForRead(
        async () => (await getMessages(adminConfiguration)) || [],
        (messages) => !messages.some((message) => message.market_id === marketId &&
          message.type_object_id === rawReplyNotification.type_object_id));
      assert(!remaining.some((message) => message.market_id === marketId &&
        message.type_object_id === rawReplyNotification.type_object_id),
        'Clearing the job must remove its previously observed reply notification');

      const after = await pollFor(getNotifications,
        (markdown) => !markdown.includes(replyTicketCode));
      assert(!after.includes(replyTicketCode),
        `The removed reply notification should disappear from the inbox: ${after}`);
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
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: `Does this first level AI question land in the inbox ${marker}?`
      });
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

    it('notifies the assignee when the AI opens a non-votable suggestion', async () => {
      const marker = randomUUID();
      const user = await adminClient.users.get();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `AI suggestion inbox ${marker}`,
        description: 'Job whose AI-authored suggestion must land in the assignee inbox.',
        assignments: [user.id]
      });
      const jobTicketCode = await getTicketCode(job);
      const suggested = await pollMcp('make_suggestion', {
        job_id: jobTicketCode,
        suggestion: `This non-votable suggestion must land in the inbox ${marker}.`
      });
      // B-all-659: the link must reach the structured result, not only the sentence.
      const addedSuggestion = JSON.parse(suggested).result?.structuredContent;
      assert(addedSuggestion?.link?.endsWith(addedSuggestion.short_code_id),
        `make_suggestion must return its link in structuredContent: ${suggested}`);
      const suggestionTicketCode = addedSuggestion.short_code_id;
      assert(suggestionTicketCode, `MCP make_suggestion response wrong: ${suggested}`);
      const expectedLink = `/${marketId}/${suggestionTicketCode}`;

      const suggestionNotifications = await pollFor(async () => {
        const messages = (await getMessages(adminConfiguration)) || [];
        return messages.filter((message) =>
          message.market_id === marketId &&
          message.investible_id === job.investible.id &&
          message.type_object_id?.startsWith('UNREAD_COMMENT_') &&
          message.link === expectedLink);
      }, (notifications) => notifications.length > 0);
      assert.strictEqual(suggestionNotifications.length, 1,
        `AI suggestion should create exactly one unread notification: ${
          JSON.stringify(suggestionNotifications)}`);
      assert.strictEqual(suggestionNotifications[0].alert_type, 'AI_GENERATED',
        'AI suggestion notification should remain marked AI_GENERATED');

      const suggestionId = suggestionNotifications[0].type_object_id
        .slice('UNREAD_COMMENT_'.length);
      const [persistedSuggestion] = await adminClient.investibles.getMarketComments([
        { id: suggestionId, version: 1 }
      ]);
      assert.strictEqual(persistedSuggestion?.ticket_code, suggestionTicketCode,
        `Notification should identify suggestion ${suggestionTicketCode}`);
      assert.strictEqual(persistedSuggestion.comment_type, 'SUGGEST');
      assert(!persistedSuggestion.inline_holder,
        'A non-votable MCP suggestion must not persist an inline holder');
      assert(!persistedSuggestion.inline_market_id,
        'A non-votable MCP suggestion must not create an inline market');

      const inbox = await pollFor(getNotifications,
        (markdown) => markdown.includes(suggestionTicketCode));
      assert(inbox.includes(suggestionTicketCode),
        `get_notifications should list AI suggestion ${suggestionTicketCode}: ${inbox}`);
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
      } finally {
        await adminClient.markets.updateGroup(marketId, { ai_auto_take: false });
      }
    }).timeout(600000);

    it('creates views and adds collaborators in a fresh workspace', async () => {
      const result = await accountClient.markets.createMarket({
        name: 'Find work directions',
        market_type: 'PLANNING'
      });
      const freshMarketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const freshLogin = await loginUserToMarketAndGetToken(adminConfiguration, freshMarketId);
      const freshToken = await mcpLogin(adminConfiguration, freshLogin.client, freshMarketId);
      const user = await accountClient.users.get();
      // The AI user is created async on market creation, so retry until MCP works.
      const pollFreshMcp = async (toolName, args) => {
        for (let i = 0; i < 10; i += 1) {
          try {
            return await mcpCall(adminConfiguration, freshToken, toolName, args);
          } catch (error) {
            await sleep(3000);
          }
        }
        return mcpCall(adminConfiguration, freshToken, toolName, args);
      };
      const first = parseMcpToolResult(await pollFreshMcp('find_work', {}));
      assert(first.work_list.length === 0,
        `Fresh market should have no work: ${JSON.stringify(first)}`);
      const second = parseMcpToolResult(await pollFreshMcp('find_work', {}));
      assert(second.directions, `Second find_work should still serve the tutorial: ${JSON.stringify(second)}`);
      // T-all-2469: the guidance promises agents can do the setup, so the tools must deliver
      const viewAdded = await pollFreshMcp('add_view', { name: 'Engineering', group_type: 'TEAM' });
      // S-all-325: the link must reach the structured result, not only the sentence.
      const addedView = JSON.parse(viewAdded).result?.structuredContent;
      assert(addedView?.link?.includes(addedView.view_id),
        `add_view must return its link in structuredContent: ${viewAdded}`);
      // T-all-2470: a later invited human can ask for their own single person view, so
      // AUTONOMOUS must work and default the name to the requesting human's
      const myViewAdded = await pollFreshMcp('add_view', { group_type: 'AUTONOMOUS' });
      assert(myViewAdded.includes(user.name),
        `add_view AUTONOMOUS should default to the user's name: ${myViewAdded}`);
      const inviteLink = await pollFreshMcp('get_invite_link', {});
      assert(inviteLink.includes('/invite/'),
        `get_invite_link should return a shareable invite link: ${inviteLink}`);
      // S-all-325: the link must reach the structured result, not only the sentence.
      // Handing back a link is this tool's entire purpose, so prose is not enough.
      const invite = JSON.parse(inviteLink).result?.structuredContent;
      assert(invite?.link?.includes('/invite/'),
        `get_invite_link must return its link in structuredContent: ${inviteLink}`);
      // J-all-401: the human can hand the agent email addresses instead of sharing a link,
      // with optional placement into a view, matching the UI's Add collaborators action
      await pollFreshMcp('add_collaborators', {
        emails: [userConfiguration.username],
        view: 'Engineering'
      });
      const engineeringGroupId = (viewAdded.match(/\/dialog\/[^/]+\/([0-9a-f-]{36})/) || [])[1];
      assert(engineeringGroupId, `add_view response should link the created view: ${viewAdded}`);

      // The email add above is the join mechanism: no invite link is ever followed, and the Engineering
      // membership assert below is attributable only to add_collaborators' view placement,
      // since a same-account login alone never follows a user into a TEAM view.
      if (!userConfiguration.idToken) {
        userConfiguration.idToken = await loginUserToIdentity(userConfiguration);
      }
      const invitedMarketLogin = await pollFor(
        () => loginUserToMarketAndGetToken(userConfiguration, freshMarketId),
        Boolean,
        20,
        3000
      );
      const invitedMarketUser = await invitedMarketLogin.client.users.get();
      const engineeringMembers = await invitedMarketLogin.client.markets.listGroupMembers(
        engineeringGroupId,
        [{ id: invitedMarketUser.id, version: 1 }]
      );
      assert(engineeringMembers.some((member) =>
        member.id === invitedMarketUser.id && !member.deleted),
      `Email-added collaborator should be in the Engineering view: ${JSON.stringify(engineeringMembers)}`);
    }).timeout(600000);

    it('clears nothing for an object without notifications', async () => {
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Quiet job ${randomUUID()}`,
        description: 'A job the human created themselves generates no self-notification.'
      });
      const jobTicketCode = await getTicketCode(job);
      const before = ((await getMessages(adminConfiguration)) || [])
        .filter((message) => message.market_id === marketId);
      assert(before.length > 0, 'Earlier fixtures must leave unrelated notifications to preserve');
      assert(!before.some((message) => message.investible_id === job.investible.id),
        'The quiet job must have no notification to clear');
      const cleared = await pollMcp('clear_notifications', { short_code_id: jobTicketCode });
      assert.notStrictEqual(JSON.parse(cleared).result.isError, true,
        `Clearing the quiet job should succeed: ${cleared}`);
      const after = ((await getMessages(adminConfiguration)) || [])
        .filter((message) => message.market_id === marketId);
      assert(before.every((previous) => after.some((current) =>
        current.type_object_id === previous.type_object_id &&
          current.is_highlighted === previous.is_highlighted)),
        'Clearing the quiet job must preserve unrelated notification rows and their highlight state');
    }).timeout(300000);
  });
}
