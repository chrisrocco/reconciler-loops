import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, DAY, HOUR, fmt } from '../src/runtime/sim.js';
import { ProdWorld, RAMP_POLICIES, STANDARD_RAMP, type Defect } from '../src/fakes/prod-world.js';
import { SCENARIOS } from '../src/fakes/catalog.js';
import { experimentWorkflow } from '../src/scenarios/experiment.js';
import { investigationWorkflow } from '../src/scenarios/investigation.js';
import type { TickRecord } from '../src/core/types.js';
import { SignalDecisions, type Decisions } from '../src/core/decisions.js';

const EXP = 'experiment:checkout_v2';
/** A regression's id: the highest stage the ramp had reached when it showed. */
const REG1 = 'regression:s1', REG2 = 'regression:s2';

function setup(defects: Defect[], o: { maxDepth?: number; maxTicksPerRun?: number; existing?: boolean; decisions?: Decisions; rampPolicy?: string; arms?: string[] } = {}) {
  const sim = new Sim();
  const world = new ProdWorld(sim);
  if (o.existing ?? true) world.addExperiment('E1', RAMP_POLICIES[o.rampPolicy ?? 'standard']!, { arms: o.arms });
  defects.forEach((d) => world.addDefect(d));
  const trace: (TickRecord & { wf: string })[] = [];
  let checkpoints = 0;
  const onTick = (wf: string) => (r: TickRecord) => trace.push({ ...r, wf });
  sim.register('experiment', (rt, input) =>
    experimentWorkflow(rt, rt.activities(world.activities()), input, {
      onTick: onTick(rt.workflowId), maxTicksPerRun: o.maxTicksPerRun, onCheckpoint: () => checkpoints++, decisions: o.decisions,
    }));
  sim.register('investigation', (rt, input) =>
    investigationWorkflow(rt, rt.activities(world.activities()), input, { onTick: onTick(rt.workflowId) }));
  const input = { flagName: 'checkout_v2', maxInvestigationDepth: o.maxDepth ?? 3 };
  const start = () => sim.start(EXP, 'experiment', input);
  return { sim, world, trace, start, checkpoints: () => checkpoints };
}

/** Invariant: the outer loop never advanced a stage while any loop-scoped blocker existed. */
function assertNeverAdvancedWhileHeld(trace: (TickRecord & { wf: string })[], world: ProdWorld) {
  for (const r of trace.filter((r) => r.wf === EXP && r.held))
    assert.ok(!r.acted.some((k) => k.startsWith('advance') || k === 'conclude'), `advanced while held at tick ${r.tick}`);
  const advances = world.exps.get('E1')!.history.filter((h) => h.key.includes('/advance'));
  for (const b of [...world.bugs.values()].filter((b) => b.parent === 'exp:checkout_v2'))
    for (const a of advances)
      // In a multi-arm experiment, a bug holds only its own arm.
      if (!a.arm || b.finding.startsWith(`regression:${a.arm}:`))
        assert.ok(!(a.at >= b.createdAt && a.at < (b.closedAt ?? Infinity)), `advanced to stage ${a.stage} while ${b.id} open`);
}

test('happy path: ramps through every stage and concludes', async () => {
  const { sim, world, start } = setup([]);
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });
  const stages = world.exps.get('E1')!.history.map((h) => h.stage);
  assert.deepEqual(stages, [0, 1, 2, 3, 4]);
  const totalSoak = STANDARD_RAMP.reduce((s, x) => s + x.soakMs, 0);
  assert.ok(sim.now >= totalSoak && sim.now < totalSoak + DAY, `finished at ${fmt(sim.now)}`);
});

test('quick fix: breach → fix CL → held until in prod → recovers → completes', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D1', signature: 'p99 regression in /checkout', guardrail: 'latency_p99', severity: 'mild', triggerStage: 1, route: 'quick-fix' },
  ]);
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');
  const fixes = [...world.cls.values()];
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0]!.key, `exp:checkout_v2/fix:${REG1}:1`);
  // While the CL rolled out, frames showed the deploy blocker and no progress.
  const heldOnDeploy = trace.filter((r) => r.wf === EXP && r.blockers.some((b) => b.startsWith('deploy:')));
  assert.ok(heldOnDeploy.length >= 3);
  assert.ok(heldOnDeploy.every((r) => r.blocked.includes(REG1) || !r.findings.includes(REG1)));
  assertNeverAdvancedWhileHeld(trace, world);
});

test('child investigation: severe breach → rollback → child bug + child workflow; parent blocked until bug closes', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'severe', triggerStage: 2, route: 'investigate', analysisHours: 30 },
  ]);
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');

  const [bug] = [...world.bugs.values()];
  assert.equal(world.bugs.size, 1);
  assert.equal(bug!.parent, 'exp:checkout_v2');
  assert.equal(bug!.status, 'fixed');
  assert.equal(sim.status(`investigate:${bug!.id}`), 'completed');

  // Rollback happened as the safety action, before anything else.
  const hist = world.exps.get('E1')!.history;
  assert.ok(hist.some((h) => h.key.includes(`rollback:${REG2}:1`) && h.stage === 1));

  // The pending child bug showed up in subsequent frames as a blocker.
  const blockedFrames = trace.filter((r) => r.wf === EXP && r.blockers.includes(`bug:${bug!.id}`));
  assert.ok(blockedFrames.length >= 2);
  assert.ok(blockedFrames.every((r) => r.held && r.blocked.includes(REG2) || !r.findings.length));
  // Parent was woken by the child's hint, not only by polling.
  assert.ok(trace.some((r) => r.wf === EXP && r.woke === 'signal:child-closed'));
  assertNeverAdvancedWhileHeld(trace, world);
});

test('recursion: investigation spawns a grandchild; the whole chain must resolve before the ramp continues', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'mild', triggerStage: 2, route: 'investigate', analysisHours: 20, requires: 'D3' },
    { id: 'D3', signature: 'stale FX rates in pricing-svc', route: 'investigate', analysisHours: 10 },
  ]);
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');

  const b1 = [...world.bugs.values()].find((b) => b.parent === 'exp:checkout_v2')!;
  const b2 = [...world.bugs.values()].find((b) => b.parent === `bug:${b1.id}`)!;
  assert.ok(b2, 'grandchild bug filed by the child investigation');
  assert.equal(b2.depth, 2);
  assert.ok(b2.closedAt! < b1.closedAt!, 'grandchild resolves before child');
  assert.equal(sim.status(`investigate:${b2.id}`), 'completed');
  // Parent only ever saw its own child bug — encapsulation.
  assert.ok(trace.filter((r) => r.wf === EXP).every((r) => !r.blockers.includes(`bug:${b2.id}`)));
  // Child investigation was itself held by its own child.
  assert.ok(trace.some((r) => r.wf === `investigate:${b1.id}` && r.blockers.includes(`bug:${b2.id}`) && r.held));
  assertNeverAdvancedWhileHeld(trace, world);
});

test('crash recovery: parent terminated right after filing the bug; a fresh run with NO memory picks up', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'severe', triggerStage: 2, route: 'investigate', analysisHours: 30 },
  ]);
  world.hooks.onBugFiled = () => {
    sim.terminate(EXP);
    sim.timer(3 * HOUR, () => start()); // someone notices and restarts it
  };
  start();
  await sim.run();
  assert.equal(sim.runs(EXP), 2);
  assert.equal((sim.result(EXP) as any).status, 'done');
  assert.equal(world.bugs.size, 1, 'no duplicate bug');
  assert.equal(world.calls.fileBug, 1);
  // The new run's first frame saw the orphaned bug as a blocker and repaired the missing investigation.
  const firstOfRun2 = trace.find((r) => r.wf === EXP && r.woke === 'start' && r.at > 0 && r.blockers.length)!;
  assert.ok(firstOfRun2.acted.some((k) => k.startsWith('start:B-1')), JSON.stringify(firstOfRun2));
  assert.equal(world.exps.get('E1')!.history.filter((h) => h.key.includes('rollback')).length, 1, 'no second rollback');
  assertNeverAdvancedWhileHeld(trace, world);
});

test('human resolves the child bug out-of-band: parent unblocks by observation, no hint needed', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'mild', triggerStage: 2, route: 'investigate', analysisHours: 240 },
  ]);
  let closedAt = 0;
  world.hooks.onBugFiled = (b) => {
    sim.timer(2 * DAY, () => world.humanShipsFix('D2'));
    sim.timer(2 * DAY + 9 * HOUR, () => { world.humanClosesBug(b.id); closedAt = sim.now; });
  };
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');
  const firstUnheld = trace.find((r) => r.wf === EXP && r.at >= closedAt && !r.held)!;
  assert.ok(firstUnheld.at - closedAt <= 6 * HOUR, `unblocked ${fmt(firstUnheld.at - closedAt)} after human closed bug`);
  // The investigation's long RCA was still running; it then saw the bug closed and finished cleanly.
  assert.equal(sim.status('investigate:B-1'), 'completed');
  assertNeverAdvancedWhileHeld(trace, world);
});

test('thrash guard: a fix that never works is escalated after 3 attempts; the ramp holds at stage 0 until out of time', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D4', signature: 'error spike in auth', guardrail: 'error_rate', severity: 'mild', triggerStage: 1, route: 'quick-fix', unfixable: true },
  ]);
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'out-of-time' });
  const agentFixes = [...world.cls.values()].filter((c) => c.parent === 'exp:checkout_v2');
  assert.deepEqual(agentFixes.slice(0, 3).map((c) => c.key), [1, 2, 3].map((n) => `exp:checkout_v2/fix:${REG1}:${n}`));

  // Escalated per finding, and the loop carried on: on-call answered, the agent got fresh attempts.
  const pages = [...world.pages.values()];
  assert.ok(pages.length >= 2, `${pages.length} pages`);
  assert.equal(pages[0]!.key, `exp:checkout_v2/escalate:${REG1}:4`);
  assert.match(pages[0]!.reason, /still unresolved after 3 attempts/);
  const exp = world.exps.get('E1')!;
  const safe = exp.history.find((h) => h.key === `exp:checkout_v2/safe-hold:${REG1}:4`)!;
  assert.ok(safe && safe.stage === 0 && safe.at <= pages[0]!.openedAt, 'rolled back to stage 0 before paging');
  assert.ok(trace.some((r) => r.wf === EXP && r.acted.includes(`fix:${REG1}:5`)), 'fresh attempts after the page');

  // Only the time budget ended it, through the safe hold.
  assert.equal(exp.stage, 0);
  assert.deepEqual(exp.escalations, ['exceeded maxDurationMs']);
  assertNeverAdvancedWhileHeld(trace, world);
});

test('playbook escalation: rollback, page on-call, hold until they resolve it, then finish the ramp', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D5', signature: 'data corruption in ledger writes', guardrail: 'error_rate', severity: 'severe', triggerStage: 2, route: 'escalate' },
  ]);
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });
  const exp = world.exps.get('E1')!;
  const rollback = exp.history.find((h) => h.key.includes(`rollback:${REG2}:1`))!;
  assert.ok(rollback, 'safety rollback ran');
  assert.equal(exp.escalations.length, 0, 'the loop never gave up');

  const [page] = [...world.pages.values()];
  assert.equal(world.pages.size, 1);
  assert.equal(page!.key, `exp:checkout_v2/escalate:${REG2}:1`);
  assert.match(page!.reason, /no automated response/);
  assert.equal(page!.status, 'resolved');
  assert.ok(rollback.at <= page!.openedAt, 'rollback before the page');
  // The open page held the loop; nothing advanced until on-call resolved it.
  const heldOnPage = trace.filter((r) => r.wf === EXP && r.blockers.includes(`page:${page!.id}`));
  assert.ok(heldOnPage.length >= 3 && heldOnPage.every((r) => r.held));
  assert.ok(exp.history.filter((h) => h.key.includes('/advance')).every((h) => h.at < page!.openedAt || h.at >= page!.resolvedAt!));
  assertNeverAdvancedWhileHeld(trace, world);
});

test('verification: a live fix for the wrong root cause does not close the bug; re-analysis finds the real one', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'mild', triggerStage: 2, route: 'investigate', analysisHours: 20, rcaWrongTimes: 1 },
  ]);
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');
  const bug = world.bugs.get('B-1')!;
  const fixes = [...world.cls.values()].filter((c) => c.parent === 'bug:B-1');
  assert.deepEqual(fixes.map((c) => c.ref), ['wrong:D2:0', 'D2']);
  assert.deepEqual(fixes.map((c) => c.key), ['bug:B-1/fix:1', 'bug:B-1/fix:2']);
  // Closed only after the right fix was live, not when the wrong one landed.
  assert.ok(bug.closedAt! >= fixes[1]!.submittedAt + world.deployLatencyMs);
  assert.match(bug.notes.join('\n'), /verified: revenue drop for EU cohort no longer reproduces/);
  assert.ok(trace.some((r) => r.wf === 'investigate:B-1' && r.acted.includes('reanalyze:1')));
  assertNeverAdvancedWhileHeld(trace, world);
});

test('verification: fixes that never cure it hand the bug to a person, holding the parent', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'mild', triggerStage: 2, route: 'investigate', analysisHours: 20, unfixable: true },
  ]);
  start();
  await sim.run();
  const bug = world.bugs.get('B-1')!;
  assert.equal(bug.status, 'open', 'never closed as fixed');
  assert.match(bug.notes.join('\n'), /needs a person: still unresolved after 3 attempts \[bug:B-1\/escalate:verify:\d+\]/);
  assert.equal(bug.withPerson?.finding, 'verify');
  // Nobody answered, so the investigation held until its time budget, then left the bug for a human.
  assert.equal((sim.result('investigate:B-1') as any).status, 'out-of-time');
  assert.match(bug.notes.join('\n'), /investigation out-of-time: .*needs a human/);
  // The parent never advanced past the open bug.
  assertNeverAdvancedWhileHeld(trace, world);
  assert.ok(world.exps.get('E1')!.history.every((h) => h.at < bug.createdAt || !h.key.includes('/advance')));
});

test('depth limit: child escalates instead of recursing; parent stays blocked until a human acts', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'mild', triggerStage: 2, route: 'investigate', analysisHours: 20, requires: 'D3' },
    { id: 'D3', signature: 'stale FX rates in pricing-svc', route: 'investigate' },
  ], { maxDepth: 1 });
  world.hooks.onBugFiled = (b) => {
    sim.timer(5 * DAY, () => world.humanShipsFix('D2'));
    sim.timer(5 * DAY + 9 * HOUR, () => world.humanClosesBug(b.id));
  };
  start();
  await sim.run();
  const b1 = world.bugs.get('B-1')!;
  assert.match(b1.notes.join('\n'), /investigation escalated: needs sub-investigation beyond maxDepth=1/);
  assert.equal(world.bugs.size, 1, 'no grandchild filed');
  assert.equal((sim.result(EXP) as any).status, 'done');
  assertNeverAdvancedWhileHeld(trace, world);
});

test('continue-as-new: memory survives JSON round-trips across many checkpoints', async () => {
  const { sim, world, start, checkpoints } = setup([
    { id: 'D1', signature: 'p99 regression in /checkout', guardrail: 'latency_p99', severity: 'mild', triggerStage: 1, route: 'quick-fix' },
  ], { maxTicksPerRun: 4 });
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');
  assert.ok(checkpoints() >= 10, `checkpoints=${checkpoints()}`);
  assert.equal(world.calls.triage, 1, 'triage memo carried across checkpoints');
  assert.equal(world.cls.size, 1, 'intent ledger carried across checkpoints');
});

// ───────────────────────────── experiment by flag ─────────────────────────────

test('by flag: no experiment on the flag, so the loop creates one from the approved draft and ramps it', async () => {
  const decisions = new SignalDecisions({ autoApprove: ['approve-config'] });
  const { sim, world, trace, start } = setup([], { existing: false, decisions });
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });
  assert.equal(world.exps.size, 1);
  const e = world.exps.get('E1')!;
  assert.equal(e.flagName, 'checkout_v2');
  assert.equal(e.launchBug, 1001);
  assert.equal(e.status, 'complete');
  assert.equal(world.calls.draftExperiment, 1, 'the draft is a judgment, made once');
  assert.deepEqual(trace.filter((r) => r.wf === EXP).flatMap((r) => r.acted).slice(0, 1), ['create:checkout_v2:1']);
});

test('by flag: a question holds the loop until a person answers; then the chosen experiment is mounted', async () => {
  const decisions = new SignalDecisions();
  const { sim, world, trace, start } = setup([], { decisions });
  world.addExperiment('E2', STANDARD_RAMP); // two experiments on the flag: no suggestion, a person picks
  sim.timer(2 * DAY, () => { decisions.answer('mount-or-create:checkout_v2', 'E2'); sim.signal(EXP, 'answered'); });
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });

  const waiting = trace.filter((r) => r.wf === EXP && r.blockers.includes('question:mount-or-create:checkout_v2'));
  assert.ok(waiting.length >= 2 && waiting.every((r) => r.held && r.at < 2 * DAY && !r.acted.length));
  const mounted = trace.find((r) => r.wf === EXP && r.acted.includes('mount:E2:1'))!;
  assert.equal(mounted.at, 2 * DAY, 'the answer woke the loop at once');
  assert.equal(world.exps.get('E2')!.status, 'complete');
  assert.equal(world.exps.get('E1')!.history.length, 1, 'the other experiment was never touched');
});

test('by flag: a run that lost its memory after creating the experiment finds it on the flag instead of creating another', async () => {
  const { sim, world, trace, start } = setup([], { existing: false });
  let restarted = false;
  sim.at(HOUR, () => { sim.terminate(EXP); sim.timer(HOUR, () => { restarted = true; start(); }); });
  start();
  await sim.run();
  assert.ok(restarted);
  assert.equal((sim.result(EXP) as any).status, 'done');
  assert.equal(world.exps.size, 1, 'no second experiment');
  assert.equal(world.calls.createExperiment, 1);
  // The fresh run asked again (auto-approved here) and mounted the experiment it found.
  assert.ok(trace.some((r) => r.wf === EXP && r.acted.includes('mount:E1:1')));
});

// ───────────────────────────── experiment variants ─────────────────────────────

test('ramp policies: each ramps through its own stages; fast finishes first, cautious last', async () => {
  const finished: Record<string, number> = {};
  for (const policy of ['fast', 'standard', 'cautious']) {
    const { sim, world, start } = setup([], { rampPolicy: policy });
    start();
    await sim.run();
    assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });
    const percents = world.exps.get('E1')!.history.map((h) => RAMP_POLICIES[policy]![h.stage]!.percent);
    assert.deepEqual(percents, RAMP_POLICIES[policy]!.map((s) => s.percent));
    finished[policy] = sim.now;
  }
  assert.ok(finished.fast! < finished.standard! && finished.standard! < finished.cautious!, JSON.stringify(finished));
});

test('long-term holdback: harm that appears ten days into the 99% stage is fixed before the holdback ends', async () => {
  const sc = SCENARIOS.find((s) => s.id === 'late-harm')!;
  const { sim, world, trace, start } = setup(sc.defects, { rampPolicy: sc.rampPolicy });
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });
  const exp = world.exps.get('E1')!;
  const at99 = exp.history.find((h) => h.stage === 4)!.at;
  const bug = world.bugs.get('B-1')!;
  assert.ok(bug.createdAt - at99 >= 10 * DAY, `bug filed ${fmt(bug.createdAt - at99)} into the holdback`);
  assert.equal(bug.status, 'fixed');
  const concluded = trace.find((r) => r.wf === EXP && r.acted.includes('conclude'))!;
  assert.ok(concluded.at >= bug.closedAt! && concluded.at >= at99 + 28 * DAY);
  assertNeverAdvancedWhileHeld(trace, world);
});

test('multi-arm: a breach in one arm rolls back only that arm; the others keep ramping while its bug is open', async () => {
  const sc = SCENARIOS.find((s) => s.id === 'multi-arm')!;
  const { sim, world, trace, start } = setup(sc.defects, { arms: sc.arms });
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });
  const exp = world.exps.get('E1')!;
  assert.deepEqual(exp.arms!.map((a) => a.stage), [4, 4, 4]);

  const bug = world.bugs.get('B-1')!;
  assert.equal(bug.finding, 'regression:B:s2');
  const rollback = exp.history.find((h) => h.key.includes('rollback:regression:B:s2:1'))!;
  assert.equal(rollback.arm, 'B');
  assert.equal(exp.history.filter((h) => h.key.includes('rollback')).length, 1, 'only B rolled back');

  // A and C advanced while B's bug was open; B never did.
  const open = (t: number) => t >= bug.createdAt && t < bug.closedAt!;
  const advances = exp.history.filter((h) => h.key.includes('/advance'));
  assert.ok(advances.some((h) => h.arm !== 'B' && open(h.at)), 'other arms kept ramping');
  assert.ok(!advances.some((h) => h.arm === 'B' && open(h.at)), 'arm B held by its bug');
  assertNeverAdvancedWhileHeld(trace, world);
});

// ───────────────────────────── regressions, not metrics ─────────────────────────────

test('correlated metrics: one regression, one triage, one bug — and a metric that joins mid-investigation is already covered', async () => {
  const sc = SCENARIOS.find((s) => s.id === 'correlated')!;
  const { sim, world, trace, start } = setup(sc.defects);
  // Watch the guardrails while the bug is open: error_rate should join the regression.
  const failingWhileOpen = new Set<string>();
  world.hooks.onBugFiled = (b) => {
    for (const h of [1, 4, 8, 12]) sim.timer(h * HOUR, () => {
      if (world.bugs.get(b.id)!.status === 'open') for (const r of world.readings('E1')) if (r.verdict === 'fail') failingWhileOpen.add(r.guardrail);
    });
  };
  start();
  await sim.run();
  assert.deepEqual(sim.result(EXP), { status: 'done', reason: 'ramped to 100%' });

  assert.deepEqual([...failingWhileOpen].sort(), ['cpu_per_query', 'error_rate', 'latency_p99'], 'three metrics failed, one joining later');
  assert.equal(world.calls.triage, 1, 'one judgment for the whole regression');
  assert.equal(world.bugs.size, 1, 'one bug, not one per metric');
  const bug = world.bugs.get('B-1')!;
  assert.equal(bug.finding, REG2);
  assert.match(bug.title, /latency_p99, cpu_per_query/);
  // Every frame saw one finding at most, with one stable id, however many metrics were failing.
  const seen = new Set(trace.filter((r) => r.wf === EXP).flatMap((r) => r.findings).filter((f) => f.startsWith('regression:')));
  assert.deepEqual([...seen], [REG2]);
  assert.ok(trace.filter((r) => r.wf === EXP && r.findings.includes(REG2)).every((r) => r.blocked.includes(REG2) || r.claimed.includes(REG2) || r.acted.length));
  assertNeverAdvancedWhileHeld(trace, world);
});

test('a regression after the ramp moves forward is a new finding, with fresh attempts', async () => {
  const { sim, world, trace, start } = setup([
    { id: 'D1', signature: 'p99 regression in /checkout', guardrail: 'latency_p99', severity: 'mild', triggerStage: 1, route: 'quick-fix' },
    { id: 'D8', signature: 'cpu blowup at high traffic', guardrail: 'cpu_per_query', severity: 'mild', triggerStage: 3, route: 'quick-fix' },
  ]);
  start();
  await sim.run();
  assert.equal((sim.result(EXP) as any).status, 'done');
  const ids = [...new Set(trace.filter((r) => r.wf === EXP).flatMap((r) => r.findings).filter((f) => f.startsWith('regression:')))];
  assert.equal(ids.length, 2);
  assert.equal(ids[0], REG1);
  assert.equal(ids[1], 'regression:s3');
  assert.deepEqual([...world.cls.values()].map((c) => c.key.replace(/^exp:checkout_v2\//, '')), [`fix:${REG1}:1`, `fix:${ids[1]}:1`]);
});
