# Agent DEV acceptance catalogs

This directory contains manual, paid agent acceptance coverage for the DEV
environment. It is intentionally separate from `testIntegration`, `testStage`,
and `testProduction` and is not part of the backend blessing gate.

## Catalogs

`npm run testAgentDev` preserves the original behavior: it runs the nine live
delivery/skill-trigger sessions (three scenarios across Claude, Codex, and
Cursor). The idle-find-work sessions also grade presentation: the agent's
user-visible reply must pair the work item's short code with its description
in one message, not show the short code alone.

`npm run testAgentDevSemantic` runs only the Codex semantic catalog. It creates
one UUID-marked `INTEGRATION_TEST` planning market and executes exactly three
independent `codex exec --ephemeral --json` processes against that shared
durable state:

1. A non-primary human's advisory reply and vote must leave the AI question,
   harmless task, and Requires Input lock unchanged.
2. After the assigned primary human answers, a fresh Codex process must resolve
   the question and continue by resolving the harmless task.
3. A fresh Codex process must address an exact standalone bug id by creating a
   human-owned `Bugs` job, moving the original thread into it, and asking an
   AI-authored options question, including its required preferred-option vote,
   that leaves the job in Requires Input.

`npm run testAgentDevSemanticStandaloneBugConversion` selects only the third
entry. It creates a fresh marked market and executes exactly one fresh Codex
process for standalone-bug conversion, without preparing advisory or primary
input and without launching either authority phase. It retains the same source
staging, credential isolation, strict transcript/state grading, artifact
redaction, and guarded exact-market cleanup as the full semantic catalog.

`npm run testAgentDevOnboarding` runs the codex onboarding catalog. It creates
one UUID-marked `INTEGRATION_TEST` planning market that stays wizard-fresh,
resets the one-time served-guidance marker on the primary identity, and
executes exactly one `codex exec --ephemeral --json` process. That process
must receive the served view and collaborator setup guidance from
`find_work`, create the requested `Engineering` TEAM view exactly once, add
the checked-in secondary identity by email into that view with
`add_collaborators` exactly once, fetch an invite link, and hand that link to
the human in its user-visible reply. The durable market state must show the
created view afterward, and the fixture proves the collaborator add by
logging in as the secondary identity and checking its Engineering view
membership. The executable catalog is `onboardingScenarios.js` and its
fixture is `onboardingFixture.js`.

`npm run testAgentDevWorkClaims` runs the work claim race catalog. It creates
one UUID-marked `INTEGRATION_TEST` planning market whose view opts into
"AI agents take the next available work from this view without asking", adds
exactly one contested Doable job with a single completion task, and launches
two identical `codex exec --ephemeral --json` processes at the same time.
Both children register the MCP proxy with `--work-claims`, so the `claim_work`
tool is exposed and the shipped skill's claim step applies. Grading is
outcome-based across both traces and the durable market: both racers must
attempt a claim for the contested short code, exactly one must be granted and
must hold that claim before its first work-producing Uclusion call, releasing
it at handoff, while the denied racer must produce no work-producing Uclusion
calls at all; durably, the contested task must be completed and resolved
exactly once. The pass depends on both racers overlapping in time, which the
simultaneous launch makes likely. The harness is `workClaimsHarness.js` with
its fixture in `workClaimsFixture.js` and grading in `workClaimsAssertions.js`.

`npm run testAgentDevQuestionGate` runs the design disclosure gate catalog. It
creates one UUID-marked `INTEGRATION_TEST` planning market whose view opts into
auto-take, plants a single Doable job whose description embeds two
reviewer-divergent forks (storage: LMDB or SQLite; refresh: manual or
automatic) with a single completion task, and launches one
`codex exec --ephemeral --json` process with an idle prompt that never mentions
disclosure or questions. Grading is durable-state based: the job must end in
Requires Input with the task untouched and no review requested, a design
disclosure note must exist naming both forks, exactly two AI questions must
exist whose options cover both alternatives of each fork, and each question
must carry the AI's own vote. The harness is `questionGateHarness.js` with its
fixture in `questionGateFixture.js`.

The executable catalog is `semanticScenarios.js`. There is deliberately no
implicit `all` mode: choosing the semantic script does not rerun the nine
transport sessions.

## Required inputs

- `TEST_AGENT_DEV_WEB_UI_ROOT` points at the `uclusion_web_ui` checkout whose
  shipped resident stub, Uclusion skill, and references will be staged.
- The DEV Uclusion identities default to the checked-in test users in
  `devIdentities.js`, the same plain-text identities the deterministic
  suites commit in `testIntegration/uclusionTest.js`, so no Uclusion
  credential input is required to run against dev. `UCLUSION_DEV_CREDENTIALS`
  and `UCLUSION_DEV_ADVISORY_CREDENTIALS` remain optional JSON overrides with
  `username` and `password` fields. Both humans join the one semantic market;
  the job assignment remains owned by the primary identity. The semantic
  catalogs join it as a second human; the onboarding catalog uses it as the
  email-added collaborator and logs in as it to prove durable membership.
- `CODEX_API_KEY`/`OPENAI_API_KEY` must be available to the harness unless
  `TEST_AGENT_DEV_USE_LOCAL_AUTH=1` explicitly enables copying the current
  Codex `auth.json` into each isolated child HOME. Provider variables are
  filtered before launch so the Codex child receives only its own credential.
- AWS credentials must permit the guarded DEV integration-market deletion
  Lambda. Cleanup supplies the exact created market id, and DEV refuses roots
  not marked `INTEGRATION_TEST`.

The semantic catalog applies a ten-minute hard timeout to every Codex process.
`TEST_AGENT_DEV_TIMEOUT_MS` remains available to the legacy trigger catalog;
`TEST_AGENT_DEV_ARTIFACT_DIR` may replace either catalog's artifact directory.

## Codex semantic policy

Every semantic invocation uses an isolated temporary HOME, config, workspace,
and fresh ephemeral thread. It passes `--ignore-user-config`, uses the
`read-only` sandbox, and configures the fresh market's Uclusion MCP server as
required. Model and reasoning effort are managed defaults: the command and
child environment contain no model or effort override.

The harness also sets only the presence marker
`UCLUSION_CODEX_BRIDGE_ACTIVE=1` in those semantic child environments. Each
prompt names its exact durable target, so the read-only process neither starts
the writable CLI wait gate nor consumes an unrelated retained Poke.

The JSONL `turn.completed` record must report nonnegative integer
`input_tokens` and `output_tokens`. Their sum may not exceed 500,000. Cached
input is already included in input and reasoning output is already included in
output, so neither is added twice. Missing or malformed usage fails closed.
There are no whole-session retries; a semantic failure is preserved as a
failure.

The source package is staged directly from the exact customer-shipped native
paths. The harness hashes the stub, skill, and references, and each semantic
trace must prove that the Uclusion skill EOF sentinel loaded before its first
Uclusion MCP call. No compact test-only workflow or instruction-size override
is used.

Every graded live phase, onboarding included, also enforces load economy: a
short code's first `get_job` may take its whole scope, and any repeat load of
the same code in one process must be scoped with `thread_only` or nonempty
`sections` instead of pulling the whole job again.

The trace contract follows the shipped compound-event routing. The
advisory-only authority check and primary-answer continuation must first load
the exact parent `Q-` from their `Responded O-… of Q-…` lines. The standalone-
bug conversion must load the exact `B-` from its `Start B-…` line. The advisory
check may not resolve or execute; the primary-answer phase must resolve that
exact question and then its exact task; and the bug-conversion phase must issue
exactly one two-option `ask_question` on the bug, reload the exact returned `J-`
Bugs job, and cast exactly one explained AI vote on one of the two resulting
options. Required audit calls and later read-only reloads are allowed and are
graded separately. The authority phases may update one well-bound AI option
vote before the primary-answer phase resolves the exact question and task.

## Artifacts

Trigger artifacts default to `testAgentDev/artifacts/`. Full semantic artifacts
default to `testAgentDev/artifacts/semantic/`; targeted standalone-bug artifacts
default to `testAgentDev/artifacts/semantic-standalone-bug-conversion/`;
onboarding artifacts default to `testAgentDev/artifacts/onboarding/`. Each
catalog records:

- one raw JSONL event/tool transcript per process;
- terminal status, signal, duration, timeout state, and bounded stderr;
- client version, telemetry-resolved model, session id, and reported usage;
- durable Uclusion state before and after each semantic phase; and
- a redacted manifest plus resolved-model summary.

Stdout traces are limited to 16 MiB and retained stderr to 256 KiB. A timeout,
trace overflow, malformed usage record, failed semantic assertion, or cleanup
failure fails the catalog and leaves diagnostic artifacts without advancing
last-known-good pins.
