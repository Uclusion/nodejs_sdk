import assert from 'assert';
import { randomUUID } from 'crypto';
import {
  loginUserToAccountAndGetToken,
  loginUserToIdentity,
  loginUserToMarketAndGetToken,
  loginUserToMarketInvite
} from '../src/utils.js';
import { mcpCall, mcpLogin, sleep } from './commonTestFunctions.js';

export default function (adminConfiguration) {
  describe('#test notifications MCP integration', () => {
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

    async function listPlanningComments() {
      const versions = await accountClient.summaries.versions(accountToken, [marketId]);
      const marketEntry = (versions.signatures || []).find((entry) => entry.market_id === marketId);
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

    function getNotifications() {
      return mcpCall(adminConfiguration, uclusionToken, 'get_notifications', {});
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

    it('lists an AI question notification and clears it by job short code', async () => {
      const marker = randomUUID();
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: `Notifications inbox ${marker}`,
        description: 'Job whose AI-authored question generates an inbox notification.'
      });
      const jobTicketCode = await getTicketCode(job);
      const questionMarker = `Does this land in the human inbox ${marker}?`;
      const asked = await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: questionMarker
      });
      assert(asked.includes('Added question with id'), `MCP ask_question response wrong: ${asked}`);
      const comments = await pollFor(listPlanningComments,
        (fetched) => fetched.some((comment) => comment.body?.includes(questionMarker)));
      const question = comments.find((comment) => comment.body?.includes(questionMarker));
      assert(question, 'AI-authored question should be discoverable');
      // The notification's link may resolve to the question or the job depending on type.
      const ticketCodes = [jobTicketCode, question.ticket_code].filter(Boolean);

      const inbox = await pollFor(getNotifications,
        (markdown) => ticketCodes.some((code) => markdown.includes(code)));
      assert(ticketCodes.some((code) => inbox.includes(code)),
        `get_notifications should list a notification about ${ticketCodes}: ${inbox}`);
      assert(!inbox.includes('No notifications.'),
        `Inbox should not render empty once the question notification exists: ${inbox}`);

      // Clearing by the JOB short code must catch the question's notification through its
      // investible id — the object the agent finished, not the individual comment.
      const cleared = await mcpCall(adminConfiguration, uclusionToken, 'clear_notifications', {
        short_code_id: jobTicketCode
      });
      assert(cleared.includes('Cleared'), `clear_notifications response wrong: ${cleared}`);
      assert(!cleared.includes('Cleared 0 '),
        `clear_notifications should match at least one notification: ${cleared}`);

      // Cleared means removed (unread types) or marked read (persistent types); either way no
      // unread line about the job or its question may remain.
      const after = await pollFor(getNotifications,
        (markdown) => !hasUnreadLine(markdown, ticketCodes));
      assert(!hasUnreadLine(after, ticketCodes),
        `No unread notification should remain about ${ticketCodes} after the clear: ${after}`);
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
