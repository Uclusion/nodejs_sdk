import assert from 'assert';
import { randomUUID } from 'crypto';
import { loginUserToIdentity, loginUserToMarket, loginUserToAccountAndGetToken, loginUserToMarketInvite }
  from '../src/utils.js';
import { pollFor } from './commonTestFunctions.js';

const QUESTIONS = 3;
const OPTIONS_PER_QUESTION = 3;

export default function (adminConfiguration) {
  describe('#test workspace export', () => {
    let adminClient;
    let marketId;
    let firstJobInfoId;
    let secondJobInfoId;
    const optionNames = [];

    // B-all-671: the export renders a job's questions' options in parallel, so every
    // option of every question must still come out
    before(async function () {
      this.timeout(600000);
      if (!adminConfiguration.idToken) {
        // The full suite bootstraps this in usersTest; keep this file standalone.
        adminConfiguration.idToken = await loginUserToIdentity(adminConfiguration);
      }
      const { client: accountClient } = await loginUserToAccountAndGetToken(adminConfiguration);
      const result = await accountClient.markets.createMarket({ name: 'Export', market_type: 'PLANNING' });
      marketId = result.market.id;
      adminClient = await loginUserToMarketInvite(adminConfiguration, result.market.invite_capability);
      const runId = randomUUID().slice(0, 8);
      const firstJob = await adminClient.investibles.create({ groupId: marketId, name: `Export job ${runId}`,
        description: 'A job whose questions and options are exported.' });
      firstJobInfoId = firstJob.market_infos[0].id;
      const secondJob = await adminClient.investibles.create({ groupId: marketId,
        name: `Second export job ${runId}`, description: 'Makes the export batch hold more than one job.' });
      secondJobInfoId = secondJob.market_infos[0].id;
      for (let question = 1; question <= QUESTIONS; question += 1) {
        const created = await adminClient.investibles.createComment(firstJob.investible.id, marketId,
          `Which choice ${question}?`, null, 'QUESTION', null, null, null, 'DECISION', false, true);
        const inlineMarketId = created.market.id;
        const inlineClient = await pollFor(() => loginUserToMarket(adminConfiguration, inlineMarketId),
          (client) => Boolean(client));
        for (let option = 1; option <= OPTIONS_PER_QUESTION; option += 1) {
          const name = `Export option ${question}-${option} ${runId}`;
          await inlineClient.investibles.create({ groupId: inlineMarketId, name,
            description: `Option ${option} of question ${question}.` });
          optionNames.push(name);
        }
      }
    });

    function missingOptions(markdown) {
      return optionNames.filter((name) => !markdown.includes(name));
    }

    it('exports every option of a job with several questions', async function () {
      this.timeout(300000);
      const markdown = await pollFor(() => adminClient.summaries.export('marketInvestible', [firstJobInfoId]),
        (exported) => typeof exported === 'string' && missingOptions(exported).length === 0);
      assert(typeof markdown === 'string', `Export returned ${JSON.stringify(markdown)}`);
      assert.deepStrictEqual(missingOptions(markdown), [], 'Every option should appear in the export');
    });

    it('exports every option when the batch renders several jobs as sections', async function () {
      this.timeout(300000);
      const sections = await pollFor(
        () => adminClient.summaries.export('marketInvestible', [firstJobInfoId, secondJobInfoId], true),
        (exported) => Array.isArray(exported) && exported.length === 2
          && missingOptions(exported.map((section) => section.markdown).join('')).length === 0);
      assert(Array.isArray(sections), `Export returned ${JSON.stringify(sections)}`);
      assert.deepStrictEqual(sections.map((section) => section.id).sort(),
        [firstJobInfoId, secondJobInfoId].sort(), 'The batch should return one section per job');
      const firstSection = sections.find((section) => section.id === firstJobInfoId);
      assert.deepStrictEqual(missingOptions(firstSection.markdown), [],
        'Every option should appear in its job\'s section');
    });
  });
}
