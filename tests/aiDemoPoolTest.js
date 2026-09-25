import assert from 'assert';
import { createHash, randomBytes } from 'crypto';
import { sleep } from './commonTestFunctions.js';

// J-Marketing-43 (Q-Marketing-203 O-3): start more than one AI demo the way the installer
// does, and check that each gets a ready demo of its own. A pooled demo is ready at
// once; an empty pool builds on demand, so the wait allows for that build too.
const READY_TIMEOUT_MS = 6 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function proof() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export default function (adminConfiguration) {
  describe('#test AI demo pool handout', () => {
    const demoURL = adminConfiguration.baseURL.replace('https://', 'https://sso.') + '/ai-demo';

    async function startDemo() {
      const { verifier, challenge } = proof();
      const started = await post(demoURL, { code_challenge: challenge });
      assert([200, 202].includes(started.status), `Start failed: ${JSON.stringify(started)}`);
      const demoId = started.body.demo_id;
      assert(UUID_RE.test(demoId), `The service must name the demo it hands out: ${JSON.stringify(started)}`);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (;;) {
        const status = await post(`${demoURL}/${demoId}/status`, { verifier });
        assert([200, 202].includes(status.status), `Status failed: ${JSON.stringify(status)}`);
        if (status.body.state === 'READY') {
          return { demoId, ...status.body };
        }
        assert.strictEqual(status.body.state, 'PROVISIONING', `Unexpected state: ${JSON.stringify(status)}`);
        assert(Date.now() < deadline, `Demo ${demoId} was not ready in time`);
        await sleep(POLL_INTERVAL_MS);
      }
    }

    it('gives each start its own ready demo', async function () {
      this.timeout(READY_TIMEOUT_MS * 2 + 60000);
      const demos = await Promise.all([startDemo(), startDemo()]);
      for (const demo of demos) {
        assert(demo.workspace_id, `A ready demo must have a workspace: ${JSON.stringify(demo)}`);
        assert(demo.client_id.startsWith(`ai-demo:${demo.demoId}:human_`),
          `The credential must belong to the demo handed out: ${JSON.stringify(demo)}`);
        assert(Array.isArray(demo.starting_job_short_codes) && demo.starting_job_short_codes.length > 0,
          `A ready demo must have starting work: ${JSON.stringify(demo)}`);
      }
      assert.notStrictEqual(demos[0].demoId, demos[1].demoId, 'Two starts must not share a demo');
      assert.notStrictEqual(demos[0].workspace_id, demos[1].workspace_id, 'Two starts must not share a workspace');
    });

    it('refuses to show a demo to anyone without its proof', async function () {
      this.timeout(READY_TIMEOUT_MS + 60000);
      const demo = await startDemo();
      const stranger = await post(`${demoURL}/${demo.demoId}/status`, { verifier: proof().verifier });
      assert.strictEqual(stranger.status, 403, `A wrong proof must be refused: ${JSON.stringify(stranger)}`);
      assert(!JSON.stringify(stranger.body).includes(demo.workspace_id), 'A refusal must not reveal the workspace');
    });
  });
}
