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
  describe('#test short codes in AI content become links (B-all-528)', () => {
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
        name: 'Short code link integration',
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

    it('turns a bare short code in an AI comment and an AI job description into a name link', async () => {
      const marker = randomUUID();
      const targetName = `Link target job ${marker}`;
      const job = await adminClient.investibles.create({
        groupId: marketId,
        name: targetName,
        description: 'Job whose short code other AI content will reference.'
      });
      const jobTicketCode = await getTicketCode(job);
      // A linkified body renders the TARGET's name as markdown link text in get_job -
      // a bare code left as plain text never produces that bracketed name.
      const linkedName = `[${targetName}](`;

      // Comment path: the AI question body mentions the code, markdown_to_quill_html links it.
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: `Is this work blocked by ${jobTicketCode} or independent of it?`
      });
      const jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        (markdown) => markdown.includes(linkedName)
      );
      assert(jobMarkdown.includes(linkedName),
        `Question body should link ${jobTicketCode} as the target job name: ${jobMarkdown}`);

      // Description path: add_job linkifies the description before the investible is stored.
      const added = await pollMcp('add_job', {
        name: `Job referencing ${marker}`,
        description: `Cannot start until ${jobTicketCode} completes.`
      });
      const addedCodeMatch = added.match(/Added job with id ([^ ]+) and link/);
      assert(addedCodeMatch, `add_job result should carry the new ticket code: ${added}`);
      const referencingMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: addedCodeMatch[1] }),
        (markdown) => markdown.includes(linkedName)
      );
      assert(referencingMarkdown.includes(linkedName),
        `Job description should link ${jobTicketCode} as the target job name: ${referencingMarkdown}`);
    }).timeout(600000);
  });
}
