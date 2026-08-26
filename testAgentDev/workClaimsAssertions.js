import assert from 'assert';
import { mcpResultTexts } from './trace.js';

// Work-producing Uclusion MCP tools the shipped workflow may only call while
// holding the contested claim. Audit markers and request_work stay out: the
// losing racer legitimately audits its turn and may report a dry spell.
const MUTATING_TOOLS = Object.freeze(new Set([
  'add_info', 'add_task', 'add_blocker', 'add_bug', 'add_job', 'add_options',
  'add_view', 'add_view_note', 'add_collaborators', 'approve_job_or_option',
  'ask_for_review', 'ask_question', 'change_job_stage',
  'make_suggestion', 'resolve', 'update_option', 'vote_on_suggestion'
]));

function uclusionToolName(call) {
  const name = String(call?.name || '').toLowerCase();
  if (name.startsWith('mcp__uclusion__')) {
    return name.slice('mcp__uclusion__'.length);
  }
  if (name.startsWith('uclusion.')) {
    return name.slice('uclusion.'.length);
  }
  return null;
}

function claimInputNamesCode(input, contestedCode) {
  if (!input || typeof input !== 'object') {
    return false;
  }
  if (input.short_code_id === contestedCode) {
    return true;
  }
  return Array.isArray(input.short_code_ids) &&
    input.short_code_ids.includes(contestedCode);
}

// Claim results come back as JSON text content from the proxy-local tool, so
// read them from the raw trace events where the result payload survives.
export function extractClaimCalls(parsed) {
  const calls = [];
  (parsed?.events || []).forEach((event, eventIndex) => {
    if (event?.type !== 'item.completed' || !event.item) {
      return;
    }
    const item = event.item;
    if (!['mcp_tool_call', 'mcp_call'].includes(item.type)) {
      return;
    }
    const tool = String(item.tool || item.tool_name || item.name || '').toLowerCase();
    if (tool !== 'claim_work') {
      return;
    }
    const input = item.arguments ?? item.args ?? item.input ?? {};
    let result = null;
    for (const text of mcpResultTexts(item.result?.content)) {
      try {
        const parsedText = JSON.parse(text);
        if (parsedText && typeof parsedText === 'object') {
          result = parsedText;
          break;
        }
      } catch (_error) {
        // Non-JSON content blocks are not claim results.
      }
    }
    calls.push({ eventIndex, input, result });
  });
  return calls;
}

function racerClaimFacts(racer, parsed, contestedCode) {
  const claims = extractClaimCalls(parsed);
  const contestedClaims = claims.filter((call) =>
    call.input?.operation === 'claim' && claimInputNamesCode(call.input, contestedCode));
  const grants = contestedClaims.filter((call) =>
    call.result?.claimed === true && call.result?.short_code_id === contestedCode);
  const denials = contestedClaims.filter((call) => call.result?.claimed === false);
  const releases = claims.filter((call) =>
    call.input?.operation === 'release' && call.input?.short_code_id === contestedCode);
  const mutations = (parsed?.toolCalls || [])
    .map((call) => ({ call, tool: uclusionToolName(call) }))
    .filter((entry) => entry.tool && MUTATING_TOOLS.has(entry.tool));
  return { racer, claims, contestedClaims, grants, denials, releases, mutations };
}

export function assertWorkClaimRace({ contestedCode, sessions }) {
  assert(contestedCode?.startsWith('J-'),
    'Work claim race grading requires the exact contested short code');
  assert.strictEqual(sessions.length, 2,
    'Work claim race grading requires exactly two racer traces');
  const facts = sessions.map(({ session, parsed }) =>
    racerClaimFacts(session.racer, parsed, contestedCode));

  for (const racer of facts) {
    assert(racer.contestedClaims.length > 0,
      `${racer.racer} never attempted a work claim for ${contestedCode}; ` +
      'the installed workflow must claim before starting auto-taken work');
  }

  const winners = facts.filter((racer) => racer.grants.length > 0);
  assert.strictEqual(winners.length, 1,
    `Exactly one racer must win the ${contestedCode} claim; ` +
    `winners: ${facts.filter((racer) => racer.grants.length > 0)
      .map((racer) => racer.racer).join(', ') || 'none'}`);
  const winner = winners[0];
  const loser = facts.find((racer) => racer !== winner);

  assert(loser.denials.length > 0,
    `${loser.racer} lost the race but never observed a denied claim for ${contestedCode}`);
  assert.strictEqual(loser.grants.length, 0,
    `${loser.racer} must never be granted the contested claim`);
  assert.strictEqual(loser.mutations.length, 0,
    `${loser.racer} was denied the claim yet called mutating Uclusion tools: ` +
    loser.mutations.map((entry) => entry.tool).join(', '));

  const grantIndex = Math.min(...winner.grants.map((call) => call.eventIndex));
  assert(winner.mutations.length > 0,
    `${winner.racer} won the claim but produced no durable work`);
  const firstMutationIndex = Math.min(...winner.mutations.map((entry) => entry.call.eventIndex));
  assert(grantIndex < firstMutationIndex,
    `${winner.racer} must hold the claim before its first mutating call ` +
    `(claim at event ${grantIndex}, mutation at event ${firstMutationIndex})`);
  assert(winner.releases.some((call) => call.eventIndex > grantIndex),
    `${winner.racer} must release the contested claim at its lane handoff`);
  return { winner: winner.racer, loser: loser.racer };
}
