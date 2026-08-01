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
  describe('#test view level notes in get_job (J-all-381)', () => {
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

    it('defaults view notes to hidden and shows Show AI notes only in the note view', async () => {
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

      let jobMarkdown = await pollMcp('get_job', { short_code_id: jobTicketCode });
      assert(!jobMarkdown.includes(noteMarker),
        'get_job must not include a view note that is not marked Show AI');

      // Flip Show AI on - only body-less update of is_visible, exactly what the UI checkbox does.
      await adminClient.investibles.updateComment(note.id, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        true, note.version);

      // T-all-2434: get_job now carries the note in a View Notes section.
      jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(noteMarker)
      );
      assert(jobMarkdown.includes('#### View Notes'),
        'get_job should render a View Notes section for Show AI view notes');
      assert(jobMarkdown.includes(noteMarker),
        'get_job should include the Show AI view note body');

      // T-all-2435: a job only gets the notes of the view it is in.
      const groupResponse = await adminClient.markets.createGroup({ name: `Engineering ${marker}` });
      const otherGroupId = groupResponse.group.id;
      const otherJob = await adminClient.investibles.create({
        groupId: otherGroupId,
        name: `Other view job ${marker}`,
        description: 'Job in a different view that must not receive the first view notes.'
      });
      const otherTicketCode = await getTicketCode(otherJob);
      const otherMarkdown = await pollMcp('get_job', { short_code_id: otherTicketCode });
      assert(!otherMarkdown.includes(noteMarker),
        'A job in another view must not receive notes from the first view');
    }).timeout(600000);
  });
}
