import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, HOUR, DAY } from '../src/runtime/sim.js';
import { reconcileToEnd } from '../src/core/reconcile.js';
import { codeReviewSpec, BOT } from '../src/scenarios/code-review.js';
import { FakeCodeReview } from '../src/fakes/review-world.js';
import type { TickRecord } from '../src/core/types.js';

const WF = 'code-review:cl/100';

function setup(startAt = 0) {
  const sim = new Sim();
  const cr = new FakeCodeReview(sim, WF);
  const trace: TickRecord[] = [];
  let checkpoints = 0;
  sim.register('code-review', (rt) =>
    reconcileToEnd(rt, codeReviewSpec(rt.activities(cr.activities()), { clId: 'cl/100' }), {
      maxTicksPerRun: 3, onTick: (r) => trace.push(r), onCheckpoint: () => checkpoints++,
    }));

  // Reviewer script over ~2 days.
  sim.at(1 * HOUR, () => {
    cr.comment('alice', 'nit: rename tmp to buffer');
    cr.comment('alice', 'bug: missing null check on user');
    cr.comment('alice', 'q: why not reuse the existing cache?');
  });
  sim.at(8 * HOUR, () => {
    cr.comment('alice', 'q: and what about eviction under memory pressure?', 't3'); // follow-up → new finding version
  });
  sim.at(9 * HOUR, () => { // arrives while the t3 draft awaits the owner
    cr.comment('alice', 'design: should this live in its own service?');
    cr.comment('alice', 'praise: nice test coverage');
  });
  sim.at(30 * HOUR, () => cr.reviewerPass('alice'));
  sim.at(54 * HOUR, () => cr.reviewerPass('alice'));
  sim.at(startAt, () => sim.start(WF, 'code-review', {}));
  return { sim, cr, trace, checkpoints: () => checkpoints };
}

test('classify → policy → act over days; drafts and escalations are finding-scoped blockers', async () => {
  const { sim, cr, trace, checkpoints } = setup();
  await sim.run();
  const out = sim.result<any>(WF);
  assert.equal(out.status, 'done');
  assert.match(out.reason, /^submitted/);

  // Six distinct findings (incl. the follow-up on t3) ⇒ six classifications, despite many ticks & checkpoints.
  assert.equal(cr.calls.classify, 6);
  assert.ok(checkpoints() >= 3);

  // nit+bug batched into ONE code revision.
  assert.equal(cr.calls.addressInCode, 1);
  const t1 = cr.cl.threads[0]!, t2 = cr.cl.threads[1]!;
  assert.equal(t1.messages.at(-1)!.body, t2.messages.at(-1)!.body);

  // Question thread: two draft replies, each published by the owner.
  const t3 = cr.cl.threads[2]!;
  assert.equal(t3.messages.filter((m) => m.author === BOT).length, 2);
  assert.ok(t3.messages.every((m) => !m.draft));

  // While a draft awaited the owner, that finding was blocked — but other work proceeded.
  const draftFrames = trace.filter((r) => r.blockers.includes('draft:t3'));
  assert.ok(draftFrames.length > 0);
  assert.ok(draftFrames.some((r) => r.acted.length > 0), 'finding-scoped blocker did not stall other findings');

  // Design comment escalated to the owner, who answered; praise auto-replied.
  assert.ok(cr.cl.threads[3]!.labels.includes('needs-owner'));
  assert.equal(cr.cl.threads[3]!.messages.at(-1)!.author, cr.cl.owner);
  assert.equal(cr.cl.threads[4]!.messages.at(-1)!.author, BOT);

  // Submitted promptly after approval, woken by the webhook hint rather than the 2h poll.
  const submitTick = trace.find((r) => r.acted.some((k) => k.startsWith('submit:')))!;
  assert.equal(submitTick.at, 30 * HOUR, `submitted at ${submitTick.at / HOUR}h`);
  assert.equal(submitTick.woke, 'signal:cl-updated');
});

test('started late (day 1.5, all comments already there): same result — the loop is level-triggered', async () => {
  const { sim, cr } = setup(1.5 * DAY);
  await sim.run();
  assert.equal(sim.result<any>(WF).status, 'done');
  assert.equal(cr.calls.classify, 5, 'the t3 follow-up was already the latest message, so one fewer version');
  assert.ok(cr.cl.submitted);
});
