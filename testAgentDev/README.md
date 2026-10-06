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

Use `node testAgentDev/run.js --client claude` to run only its three Claude
scenarios. This preflights only Claude and leaves the shared nine-session
last-known-good pins and last-green record unchanged. Claude delivery accepts
a persistent Monitor or a one-day background wait. The first-Poke scenario
also checks that an ended background wait is re-armed after receiving the Poke.

`npm run testAgentDevSemantic` runs only the Codex semantic catalog. It creates
one UUID-marked `INTEGRATION_TEST` planning market and executes exactly three
independent `codex exec --ephemeral --json` processes against that shared
durable state:

1. A non-primary human's advisory reply and vote must leave the AI question,
   harmless task, and Requires Input lock unchanged.
2. After the assigned primary human answers, a fresh Codex process must resolve
   the question and continue by resolving the harmless task.
3. A fresh Codex process must address an exact standalone bug id by creating a
   human-owned job with the requested name, moving the original thread into it,
   and asking an AI-authored options question, including its required
   preferred-option vote, that leaves the job in Approvable.

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

`npm run testAgentDevDesignWriting` runs the one-process design-writing
acceptance catalog. It creates one disposable UUID-marked `INTEGRATION_TEST`
planning market and one human-owned Doable job with a literal actor-to-terminal
lifecycle and exactly two resolved choices backed by the primary human's For
votes. One fresh paid `codex exec --ephemeral --json` process must load the
complete core Uclusion skill, the complete sibling `uclusion-design` skill,
and that skill's complete examples reference before it creates the job's
capsule. The durable result must be exactly one current,
pinned, job-scoped capsule. Each selected choice's exact `Q-` and `O-` evidence,
descriptive link, and selected behavior must occur in the same claim block, so
a detached evidence ledger fails. The literal actor trigger, terminal success,
and terminal failure anchors must survive in order. The process may make no
other workflow mutation beyond the Uclusion audit telemetry required by the
installed workflow.

The design-writing catalog uses the shared semantic harness, including its
ten-minute timeout, fail-closed 500,000-token ceiling, no whole-session retry,
credential redaction, isolated workspace and HOME, and guarded deletion of the
exact marked market. Its executable scenario, fixture, and grader are
`designWritingScenarios.js`, `designWritingFixture.js`, and
`designWritingAssertions.js`.

`npm run testAgentDevStageAuthorization` runs two fresh Codex processes against
two separate human-owned Approvable jobs. The negative process receives an
exact Start after a real AI-recommended option was selected by the primary
human, resolved, and captured in a current capsule with AI job approval already
settled. Earlier take-up and "let's just fix it" comments are the last human
context. The process must leave the job Approvable and its task and settled plan
untouched, then ask one durable question about the exact Doable transition. The
positive process receives an explicit named-job-to-Doable stage-only request
and must perform only that transition. The catalog also proves that neither
process mutates the other job. Its scenario, fixture, and grader are
`stageAuthorizationScenarios.js`, `stageAuthorizationFixture.js`, and
`stageAuthorizationAssertions.js`.

`npm run testAgentDevCompletionPackage` runs one fresh Codex process against a
completed, human-owned job that begins Doable with one open AI review whose
capsule-delta report ends in its completion package. The same package is
carried as the immediately preceding agent prompt without adding a second paid
turn or a resume harness. Only `all` is tested: any other reply is an ordinary
instruction in the human's own words. The agent must order commit, local push,
a fresh notification check, the Reviewable transition from Doable with its
completion sweep, and last the exact-job clear carrying the terminal record,
before any lane discovery. Durable grading forbids a second review or package
prompt and preserves unrelated changes, notifications, and jobs. The catalog is
defined by
`completionPackageScenarios.js`, `completionPackageFixture.js`, and
`completionPackageAssertions.js`.

`npm run testAgentDevTokenBreakdown` runs the token breakdown catalog (J-all-492).
It runs one Claude Code session and one Codex session, each in its own fresh
marked market. Each session takes up a Doable probe job with the token audit
on, adds one progress note, ends the audit and stops. The Claude Code session
runs persisted, unlike the other catalogs, with the audit's hooks in the
workspace's project settings. Because a one-shot session exits with its MCP
proxy, the harness starts that proxy again on the same audit store so it
publishes the final note. The Codex session runs through ordinary `codex` with the native Uclusion MCP
adapter in a pseudo-terminal (`tokenBreakdownCodexSession.py`). It stays open until the job's final audit note
appears. Grading reads that note through the raw export Lambda and runs
`uclusion usage` on the session's saved transcript or rollout. Both must show
the skill, bootstrap, tool definition and MCP framing lines. Neither may
contain anything but line names and numbers, which the harness checks with a
canary string in the job description. The catalog needs
`public/scripts/token-manifest.json`, `ANTHROPIC_API_KEY` for the Claude Code
session, and Codex auth as below. It is defined by
`tokenBreakdownScenarios.js` and `tokenBreakdownHarness.js`.

The original three-phase semantic catalog is `semanticScenarios.js`. There is
deliberately no implicit `all` mode: choosing a semantic-harness script does
not rerun the nine transport sessions.

## Required inputs

- `TEST_AGENT_DEV_WEB_UI_ROOT` points at the `uclusion_web_ui` checkout whose
  shipped resident stub, Uclusion skill, and references will be staged.
- The DEV Uclusion identities default to the checked-in test users in
  `devIdentities.js`, the same plain-text identities the deterministic
  suites commit in `testIntegration/uclusionTest.js`, so no Uclusion
  credential input is required to run against dev. `UCLUSION_DEV_CREDENTIALS`
  and `UCLUSION_DEV_ADVISORY_CREDENTIALS` remain optional JSON overrides with
  `username` and `password` fields. The authority semantic catalog joins both
  humans while keeping the job assigned to the primary identity. The
  design-writing catalog needs only that primary human. The onboarding catalog
  uses the secondary identity as the email-added collaborator and logs in as it
  to prove durable membership.
- `CODEX_API_KEY`/`OPENAI_API_KEY` must be available to the harness unless
  `TEST_AGENT_DEV_USE_LOCAL_AUTH=1` explicitly enables copying the current
  Codex `auth.json` into each isolated child HOME. Provider variables are
  filtered before launch so the Codex child receives only its own credential.
- AWS credentials must permit the guarded DEV integration-market deletion
  Lambda. Cleanup supplies the exact created market id, and DEV refuses roots
  not marked `INTEGRATION_TEST`.

Every semantic-harness catalog applies a ten-minute hard timeout to each Codex
process.
`TEST_AGENT_DEV_TIMEOUT_MS` remains available to the legacy trigger catalog;
`TEST_AGENT_DEV_ARTIFACT_DIR` may replace either catalog's artifact directory.

## Codex semantic policy

Every semantic invocation uses an isolated temporary HOME, config, workspace,
and fresh ephemeral thread. It passes `--ignore-user-config` and configures the
fresh market's Uclusion MCP server as required. Semantic catalogs use the
`read-only` sandbox except the completion-package phase, which uses
`workspace-write` solely against its disposable workspace. That phase keeps their working repository metadata in an ignored directory inside
that workspace so real local commits remain sandbox-writable, and initialize
an ignored bare origin and export directory beside it. No Git-hosting or SSH
credential, real remote, or external workspace path is passed to the child.
Model and reasoning effort are managed defaults: the command and child
environment contain no model or effort override. The longer completion
phase has a 1,000,000-reported-token process ceiling; every other semantic
process retains the 500,000-token ceiling. Only the completion phase enables
workspace-write command networking, because its required fresh DEV export must
reach Uclusion before the completion scan can run.

Each semantic prompt names its exact durable target. These headless processes
use their explicit fixture instructions and do not consume unrelated retained
Pokes. Native delivery and live accounting are exercised by the separate
interactive Codex accounting session.

The JSONL `turn.completed` record must report nonnegative integer
`input_tokens` and `output_tokens`. Their sum may not exceed 500,000. Cached
input is already included in input and reasoning output is already included in
output, so neither is added twice. Missing or malformed usage fails closed.
There are no whole-session retries; a semantic failure is preserved as a
failure.

The source package is staged directly from the exact customer-shipped native
paths. The harness hashes and byte-verifies both complete sibling skill
packages after staging for Claude, Cursor, or Codex. Each semantic trace must
prove that the Uclusion skill EOF sentinel loaded before its first Uclusion MCP
call; the design-writing catalog additionally proves the sibling design skill
and its examples from their exact entry markers through their EOF sentinels
before the capsule write. No compact test-only workflow or instruction-size
override is used.

The original semantic phases and onboarding also enforce load economy: a short
code's first `get_job` may take its whole scope, and any repeat load of the same
code in one process must be scoped with `thread_only` or nonempty `sections`
instead of pulling the whole job again.

The trace contract follows the shipped compound-event routing. The
advisory-only authority check and primary-answer continuation must first load
the exact parent `Q-` from their `Responded O-… of Q-…` lines. The standalone-
bug conversion must load the exact `B-` from its `Start B-…` line. The advisory
check may not resolve or execute; the primary-answer phase must resolve that
exact question and then its exact task; and the bug-conversion phase must issue
exactly one two-option `ask_question` on the bug with its explained `initial_vote`,
then reload the exact returned `J-` Bugs job. Its saved AI investment must match
the requested option and certainty and link to a live reason on that option.
Required audit calls and later read-only reloads are allowed and are
graded separately. The authority phases may update one well-bound AI option
vote before the primary-answer phase resolves the exact question and task.

The stage-authorization catalog grades durable outcomes and exact workflow
targets. General work language may only create the exact job's Doable
permission question. That question may offer concrete Move/Keep answers and one
question-local AI option vote; neither authorizes the transition. An explicit
stage-only request may only call `change_job_stage` for the named job and
`Doable`. Both jobs and tasks are snapshotted around each phase so a
compensating or unrelated mutation fails.

## Artifacts

Trigger artifacts default to `testAgentDev/artifacts/`. Full semantic artifacts
default to `testAgentDev/artifacts/semantic/`; targeted standalone-bug artifacts
default to `testAgentDev/artifacts/semantic-standalone-bug-conversion/`;
onboarding artifacts default to `testAgentDev/artifacts/onboarding/`; and
design-writing artifacts default to `testAgentDev/artifacts/design-writing/`.
Stage-authorization artifacts default to
`testAgentDev/artifacts/stage-authorization/`.
Completion-package artifacts default to
`testAgentDev/artifacts/completion-package/`.
Each catalog records:

- one raw JSONL event/tool transcript per process;
- terminal status, signal, duration, timeout state, and bounded stderr;
- client version, telemetry-resolved model, session id, and reported usage;
- durable Uclusion state before and after each semantic phase; and
- a redacted manifest plus resolved-model summary.

After an unfiltered catalog passes, `last-green.json` beside its
`manifest.json` records the catalog, run ID, and exact `passed_at` time. Failed
runs and `--phase`-narrowed runs leave that marker untouched, so it always
answers when the complete catalog most recently passed.

Stdout traces are limited to 16 MiB and retained stderr to 256 KiB. A timeout,
trace overflow, malformed usage record, failed semantic assertion, or cleanup
failure fails the catalog and leaves diagnostic artifacts without advancing
last-known-good pins.
