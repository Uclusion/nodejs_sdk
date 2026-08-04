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
  describe('#test short codes in AI content become internal-form links (B-all-528, C-all-1358, B-all-530)', () => {
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
      // C-all-1358: internal-form hrefs round trip through get_job as [name](#code) -
      // plain code text never produces the bracketed name, and the retired absolute
      // ticket-code form could only export as a raw URL, never the #code anchor.
      const linkedName = `[${targetName}](#${jobTicketCode})`;
      // B-all-530: a code inside a markdown code span must stay bare - only real markdown
      // conversion protects it, the old raw-text regex linkified straight through backticks.
      const codeSpan = `\`${jobTicketCode}\``;

      // Comment path: the AI question body mentions the code, markdown_to_quill_html links it.
      // Option path: the option description converts from markdown and linkifies too.
      await pollMcp('ask_question', {
        job_id: jobTicketCode,
        question: `Is this work blocked by ${jobTicketCode} or independent of it?`,
        options: [{
          name: 'Blocked',
          description: `Wait for ${jobTicketCode} but keep ${codeSpan} in scripts.`
        }]
      });
      const questionDone = (markdown) => markdown.split(linkedName).length > 2 && markdown.includes(codeSpan);
      const jobMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: jobTicketCode }),
        questionDone
      );
      assert(jobMarkdown.split(linkedName).length > 2,
        `Question body and option description should each link ${jobTicketCode} as the target job name: ${jobMarkdown}`);
      assert(jobMarkdown.includes(codeSpan),
        `Option description code span should keep ${jobTicketCode} bare: ${jobMarkdown}`);

      // Description path: add_job converts the description from markdown, which links the code.
      const added = await pollMcp('add_job', {
        name: `Job referencing ${marker}`,
        description: `Cannot start until ${jobTicketCode} completes.\n\nLeave ${codeSpan} alone in scripts.`
      });
      const addedCodeMatch = added.match(/Added job with id ([^ ]+) and link/);
      assert(addedCodeMatch, `add_job result should carry the new ticket code: ${added}`);
      const referencingMarkdown = await pollFor(
        () => mcpCall(adminConfiguration, uclusionToken, 'get_job', { short_code_id: addedCodeMatch[1] }),
        (markdown) => markdown.includes(linkedName) && markdown.includes(codeSpan)
      );
      assert(referencingMarkdown.includes(linkedName),
        `Job description should link ${jobTicketCode} as the target job name: ${referencingMarkdown}`);
      assert(referencingMarkdown.includes(codeSpan),
        `Job description code span should keep ${jobTicketCode} bare: ${referencingMarkdown}`);
    }).timeout(600000);
  });
}
