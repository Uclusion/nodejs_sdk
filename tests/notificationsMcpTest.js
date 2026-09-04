import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  getMessages,
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, pollFor, sleep } from './commonTestFunctions.js';

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
        info: `AI reply that must generate a tracked notification ${marker}.`,
        tz: 'America/Los_Angeles'
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
      const suggestionMatch = suggested.match(/Added suggestion with id (\S+) and link/);
      assert(suggestionMatch, `MCP make_suggestion response wrong: ${suggested}`);
      const suggestionTicketCode = suggestionMatch[1];
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

    it('serves view setup guidance once for a wizard-fresh workspace', async () => {
      // T-all-2468: find_work tells the agent about connect-AI onboarding state instead of
      // shipping the setup guidance statically and letting the agent guess. A fresh market
      // keeps the work list empty so the directions path is exercised deterministically.
      const result = await accountClient.markets.createMarket({
        name: 'Find work directions',
        market_type: 'PLANNING'
      });
      const freshMarketId = result.market.id;
      await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const freshLogin = await loginUserToMarketAndGetToken(adminConfiguration, freshMarketId);
      const freshToken = await mcpLogin(adminConfiguration, freshLogin.client, freshMarketId);
      // Reset the served marker so this test passes on reruns with the same user
      const user = await accountClient.users.get();
      const priorPreferences = user.ui_preferences ? JSON.parse(user.ui_preferences) : {};
      delete priorPreferences.aiViewSetupGuidanceShown;
      await accountClient.users.update({ uiPreferences: JSON.stringify(priorPreferences) });
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
      assert(first.directions && first.directions.includes('Offer view and collaborator setup first'),
        `First empty find_work should serve setup guidance: ${JSON.stringify(first.directions)}`);
      const second = parseMcpToolResult(await pollFreshMcp('find_work', {}));
      assert(second.directions, `Second find_work should still serve the tutorial: ${JSON.stringify(second)}`);
      assert(!second.directions.includes('Offer view and collaborator setup first'),
        `Second find_work should not repeat setup guidance: ${JSON.stringify(second.directions)}`);
      // T-all-2469: the guidance promises agents can do the setup, so the tools must deliver
      const viewAdded = await pollFreshMcp('add_view', { name: 'Engineering', group_type: 'TEAM' });
      assert(viewAdded.includes('Added view Engineering'),
        `add_view should create and confirm the view: ${viewAdded}`);
      // T-all-2470: a later invited human can ask for their own single person view, so
      // AUTONOMOUS must work and default the name to the requesting human's
      const myViewAdded = await pollFreshMcp('add_view', { group_type: 'AUTONOMOUS' });
      assert(myViewAdded.includes(`Added view ${user.name}`),
        `add_view AUTONOMOUS should default to the user's name: ${myViewAdded}`);
      const inviteLink = await pollFreshMcp('get_invite_link', {});
      assert(inviteLink.includes('/invite/'),
        `get_invite_link should return a shareable invite link: ${inviteLink}`);
      // J-all-401: the human can hand the agent email addresses instead of sharing a link,
      // with optional placement into a view, matching the UI's Add collaborators action
      const collaboratorAdd = await pollFreshMcp('add_collaborators', {
        emails: [userConfiguration.username],
        view: 'Engineering'
      });
      assert(collaboratorAdd.includes('Added 1 collaborator by email and placed in view Engineering'),
        `add_collaborators should add by email into the view: ${collaboratorAdd}`);
      const engineeringGroupId = (viewAdded.match(/\/dialog\/[^/]+\/([0-9a-f-]{36})/) || [])[1];
      assert(engineeringGroupId, `add_view response should link the created view: ${viewAdded}`);

      // T-all-2470: a later invited human's first MCP contact gets the joined-workspace
      // guidance offering their own single person view, also exactly once. The email add
      // above is the join mechanism: no invite link is ever followed, and the Engineering
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
      // Reset the served marker through the market-scoped client: the backend reads
      // and writes the marker on the market user row, and the email add copies the
      // account row's preferences when it creates that row, so an account-level
      // reset done here would miss stale state on reruns with the same user.
      const invitedPreferences = invitedMarketUser.ui_preferences
        ? JSON.parse(invitedMarketUser.ui_preferences)
        : {};
      delete invitedPreferences.aiViewSetupGuidanceShown;
      await invitedMarketLogin.client.users.update({
        uiPreferences: JSON.stringify(invitedPreferences)
      });
      const invitedToken = await mcpLogin(userConfiguration, invitedMarketLogin.client, freshMarketId);
      const pollInvitedMcp = async (toolName, args) => {
        for (let i = 0; i < 10; i += 1) {
          try {
            return await mcpCall(userConfiguration, invitedToken, toolName, args);
          } catch (error) {
            await sleep(3000);
          }
        }
        return mcpCall(userConfiguration, invitedToken, toolName, args);
      };
      const joined = parseMcpToolResult(await pollInvitedMcp('find_work', {}));
      assert(joined.directions && joined.directions.includes('Offer their own view first'),
        `Invited user's first empty find_work should serve joined guidance: ${JSON.stringify(joined.directions)}`);
      assert(!joined.directions.includes('Offer view and collaborator setup first'),
        `Invited user should not get the creator guidance: ${JSON.stringify(joined.directions)}`);
      const joinedAgain = parseMcpToolResult(await pollInvitedMcp('find_work', {}));
      assert(joinedAgain.directions && !joinedAgain.directions.includes('Offer their own view first'),
        `Second invited find_work should not repeat joined guidance: ${JSON.stringify(joinedAgain.directions)}`);
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
