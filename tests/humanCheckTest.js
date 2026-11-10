import assert from 'assert';
import { randomBytes } from 'crypto';
import uclusion from 'uclusion_sdk';

// J-all-519: the server refuses an email signup or resend that has no valid "I am human" token,
// even when the caller never loads a page. Cloudflare's documented dummy token is accepted by
// the always-pass test secret that stage and dev hold, and rejected by production's real secret.
const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const PRODUCTION_BASE_URL = 'https://production.api.uclusion.com/v1';

function freshAddress() {
  // At uclusion.com, so an email sent by a regression stays in-house; not a UI test identity.
  return `humancheck+${randomBytes(6).toString('hex')}@uclusion.com`;
}

async function expectRefused(request, label) {
  let result;
  try {
    result = await request;
  } catch (error) {
    assert.strictEqual(error?.status, 403, `${label} should be refused with 403, got ${error?.status ?? error}`);
    return;
  }
  assert.fail(`${label} should be refused with 403 but returned ${JSON.stringify(result)}`);
}

export default function (adminConfiguration) {
  describe('#human check on email signup and resend', () => {
    it('refuses signup and resend without a token and accepts a token through the SDK', async () => {
      const ssoClient = await uclusion.constructSSOClient(adminConfiguration);
      const email = freshAddress();
      const signupData = { name: 'Human Check', email, password: `Hc1-${randomBytes(8).toString('hex')}` };

      await expectRefused(ssoClient.userSignup(signupData), 'Signup without a token');
      // Refused rather than 404, so the check comes before revealing whether a signup exists
      await expectRefused(ssoClient.resendVerification(freshAddress()), 'Resend without a token');

      if (adminConfiguration.baseURL === PRODUCTION_BASE_URL) {
        // Production's real secret rejects the dummy token, and real tokens need a browser
        return;
      }
      const result = await ssoClient.userSignup({ ...signupData, human_check_token: TURNSTILE_DUMMY_TOKEN });
      // USER_CREATED rather than VERIFICATION_RESENT proves the refused signup created no user
      assert.strictEqual(result.response, 'USER_CREATED',
        `Signup with a token should create the user, got ${JSON.stringify(result)}`);
    }).timeout(60000);
  });
}
