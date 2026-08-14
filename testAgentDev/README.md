# Agent DEV acceptance catalogs

This directory contains manual, paid agent acceptance coverage for the DEV
environment. It is intentionally separate from `testIntegration`, `testStage`,
and `testProduction` and is not part of the backend blessing gate.

## Catalogs

`npm run testAgentDev` preserves the original behavior: it runs the nine live
delivery/skill-trigger sessions (three scenarios across Claude, Codex, and
Cursor).

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

The executable catalog is `semanticScenarios.js`. There is deliberately no
implicit `all` mode: choosing the semantic script does not rerun the nine
transport sessions.

## Required inputs

- `TEST_AGENT_DEV_WEB_UI_ROOT` points at the `uclusion_web_ui` checkout whose
  shipped resident stub, Uclusion skill, and references will be staged.
- `UCLUSION_DEV_CREDENTIALS` supplies the primary DEV test identity as JSON
  with `username` and `password` fields.
- `UCLUSION_DEV_ADVISORY_CREDENTIALS` supplies a distinct non-primary DEV test
  identity in the same JSON shape. Both humans join the one semantic market;
  the job assignment remains owned by the primary identity.
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
default to `testAgentDev/artifacts/semantic-standalone-bug-conversion/`. Each
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
