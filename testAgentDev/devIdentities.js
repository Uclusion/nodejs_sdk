// The DEV Uclusion test identities are deliberately plain text, matching
// testIntegration/uclusionTest.js: they exist only on dev, exactly like the
// deterministic integration suites that commit them. Keep the two files in
// sync. Provider credentials (Claude, Codex, Cursor) are real secrets and
// must never be added here; they arrive via API keys or local client auth.
export const DEV_PRIMARY_IDENTITY = Object.freeze({
  username: 'david.israel@uclude.com',
  password: 'Uclusi0n_test'
});

export const DEV_ADVISORY_IDENTITY = Object.freeze({
  username: '827hooshang@gmail.com',
  password: 'Uclusi0n_test'
});
