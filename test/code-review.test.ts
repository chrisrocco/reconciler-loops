import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, HOUR, DAY } from '../src/runtime/sim.js';
import { reconcileToEnd } from '../src/core/reconcile.js';
import { AGENT, blockersIn, codeReviewLoop, findingsIn, pickReviewer, type ChangeView } from '../src/scenarios/code-review.js';
import { LOST_DRAFTS, ReviewSystem, SLOW_REVIEWER, STUCK_CHECK, TYPICAL, VOTES_RESET, type ReviewSystemConfig } from '../src/fakes/review-system.js';
import type { TickRecord } from '../src/core/types.js';

const WF = 'code-review:change/100';

function run(cfg: ReviewSystemConfig, o: { startAt?: number } = {}) {
  const sim = new Sim();
  const rs = new ReviewSystem(sim, WF, cfg);
  const trace: TickRecord[] = [];
  sim.register('code-review', (rt) =>
    reconcileToEnd(rt, codeReviewLoop(rt.activities(rs.activities()), { change: 'change/100' }), { maxTicksPerRun: 20, onTick: (r) => trace.push(r) }));
  sim.at(o.startAt ?? 0, () => sim.start(WF, 'code-review', {}));
  const acted = () => trace.flatMap((r) => r.acted);
  return { sim, rs, trace, acted, done: async () => { await sim.run({ maxMs: 60 * DAY }); return sim.result<any>(WF); } };
}

// ───────────────────────────── what the loop sees (pure) ─────────────────────────────

const view = (over: Partial<ChangeView> = {}): ChangeView => ({
  id: 'change/1', owner: 'olivia', status: 'open', patchset: 2, reviewers: [], attention: [], away: [],
  requirements: [], threads: [], checks: [], mergeable: { ok: true }, ...over,
});

test('findings: every unmet requirement is a finding; a running check is a finding the run blocks', () => {
  const c = view({
    requirements: [{ id: 'owners:web/', summary: 'an owner of web/', satisfied: false, eligible: ['carol'] }, { id: 'review', summary: '', satisfied: true, eligible: [] }],
    checks: [{ name: 'build', required: true, state: 'running', patchset: 2, startedAt: 0, runs: 1, likelyFlaky: false }],
    threads: [
      { id: 't1', origin: 'person', resolved: false, messages: [{ id: 'm1', author: 'alice', body: 'nit: x', at: 0 }] },
      { id: 't2', origin: 'person', resolved: false, messages: [{ id: 'm2', author: 'alice', body: 'q', at: 0 }, { id: 'm3', author: AGENT, body: 'because', at: 1 }] },
    ],
    mergeable: { ok: false, targetHead: 'h1', autoRebase: true },
  });
  assert.deepEqual(findingsIn(c).map((f) => f.id), ['thread:t1@m1', 'owners:web/', 'check:build', 'conflict']);
  assert.deepEqual(blockersIn(c).map((b) => [b.id, b.on]), [['running:build', ['check:build']]]);
});

test('blockers: a present reviewer who can grant a requirement covers it, aging only while it is their turn', () => {
  const owners = { id: 'owners:web/', summary: '', satisfied: false, eligible: ['bob', 'carol'] };
  let c = view({ requirements: [owners], reviewers: [{ user: 'carol', kind: 'person', addedAt: 0, turnSince: 5 }] });
  assert.deepEqual(blockersIn(c).map((b) => [b.id, b.on, b.since]), [['reviewer:carol:owners:web/', ['owners:web/'], 5]]);
  // Away: doesn't count, so the requirement is open again, and the next pick skips the absent owner.
  c = view({ requirements: [owners], reviewers: [{ user: 'carol', kind: 'person', addedAt: 0, away: true }], away: ['bob', 'carol'] });
  assert.deepEqual(blockersIn(c), []);
  assert.equal(pickReviewer(owners, c), undefined);
  assert.equal(pickReviewer(owners, view({ away: ['bob'] })), 'carol');
});

// ───────────────────────────── a whole review ─────────────────────────────

test('a typical review: judged once per message, fixes batched, the right reviewers added, submitted when every requirement is met', async () => {
  const { rs, acted, done } = run(TYPICAL);
  const out = await done();
  assert.equal(out.status, 'done');
  assert.match(out.reason, /^submitted at patchset \d+$/);
  assert.equal(rs.status, 'submitted');

  // Seven messages needed a response (four from alice, then praise, carol's suggestion, an analyzer finding): seven judgments.
  assert.equal(rs.calls.judge, 7);
  // The analyzer finding didn't apply here: dismissed as not useful, not "fixed".
  assert.ok(rs.threads[0]!.resolved && rs.threads[0]!.messages.at(-1)!.body.startsWith('Not useful'));
  // owners:web/ had nobody on the change: bob is away, so carol was added.
  assert.ok(acted().includes('add-reviewer:owners:web/:carol'));
  assert.ok(!acted().some((k) => k.includes(':bob')));
  // Alice's nit and bug arrived together and went into one revision.
  const revisions = acted().filter((k) => k.startsWith('revise:'));
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.match(/thread:/g)!.length, 2, revisions[0]);
  // The flaky check was rerun once on its patchset, not "fixed".
  assert.ok(acted().some((k) => k.startsWith('rerun:check:unit-tests@ps')));
  // The design question went to the owner; carol's suggestion became a draft the owner published.
  assert.ok(acted().some((k) => k.startsWith('escalate:thread:')));
  assert.ok(rs.threads.some((t) => t.messages.some((m) => m.author === 'olivia' && m.body.startsWith('Decision'))));
  assert.ok(rs.events.some((e) => e.who === 'olivia' && e.what.startsWith('published the agent')));
  // The target branch moved; a clean rebase followed.
  assert.ok(acted().some((k) => k.startsWith('rebase:conflict:')));
  // Submitted with every requirement met.
  assert.ok(rs.requirements().every((r) => r.satisfied));
});

test('started late, with every comment already there: the same result, because the loop is level-triggered', async () => {
  const early = run(TYPICAL);
  await early.done();
  const late = run(TYPICAL, { startAt: 30 * HOUR });
  const out = await late.done();
  assert.equal(out.status, 'done');
  assert.equal(late.rs.calls.judge, early.rs.calls.judge);
  assert.ok(late.rs.requirements().every((r) => r.satisfied));
});

test('a lost draft is retried under a new key, then the thread goes to the owner', async () => {
  const { acted, done } = run(LOST_DRAFTS);
  await done();
  const t = acted().filter((k) => k.includes('thread:t1'));
  assert.deepEqual(t.slice(0, 4), [1, 2, 3].map((n) => `reply:thread:t1@m1:${n}`).concat('escalate:thread:t1@m1:4'));
});

test('a reviewer who never takes their turn: the requirement ages out, the owner is tagged, and swaps them', async () => {
  const { rs, trace, acted, done } = run(SLOW_REVIEWER);
  const out = await done();
  assert.equal(out.status, 'done');
  // Blocked by dave for two days, then escalated: the owner removed dave and added carol.
  const esc = trace.find((r) => r.acted.some((k) => k.startsWith('escalate:owners:web/')))!;
  assert.ok(esc && esc.at >= 2 * DAY, `escalated at ${esc?.at}`);
  assert.ok(rs.events.some((e) => e.who === 'olivia' && e.what === 'removed dave'));
  assert.ok([...rs.reviewers.keys()].includes('carol'));
  assert.ok(!acted().some((k) => k.startsWith('add-reviewer:owners:web/')), 'dave counted as coverage, so the loop waited instead of adding someone');
});

test('votes that reset on a new patchset: the reviewer approves again before the change is submitted', async () => {
  const { rs, acted, done } = run(VOTES_RESET);
  const out = await done();
  assert.equal(out.status, 'done');
  // The conflict at head needed a code change, which reset alice's approval; she approved the new patchset.
  assert.ok(acted().some((k) => k.startsWith('revise:conflict')));
  const approvals = rs.events.filter((e) => e.who === 'alice' && e.what.startsWith('approved'));
  assert.ok(approvals.length >= 2, approvals.map((e) => e.what).join('; '));
  assert.equal(rs.votes.get('alice'), rs.patchset, 'submitted on an approval of the final patchset');
});

test('a check that keeps failing for real is escalated after three fixes, and the owner fixes it', async () => {
  const { rs, acted, done } = run(STUCK_CHECK);
  const out = await done();
  assert.equal(out.status, 'done');
  assert.deepEqual(acted().filter((k) => k.includes('check:integration')).slice(0, 4),
    ['revise:check:integration:1', 'revise:check:integration:2', 'revise:check:integration:3', 'escalate:check:integration:4']);
  assert.ok(rs.threads.some((t) => t.messages.some((m) => m.author === 'olivia' && m.body === 'Fixed integration myself.')));
});
