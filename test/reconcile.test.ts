import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, HOUR, DAY, MIN } from '../src/runtime/sim.js';
import { buildFrame, escalation, forget, migrate, newMemory, reconcile, reconcileToEnd, type LoopMemoryV1 } from '../src/core/reconcile.js';
import type { Action, Blocker, Budget, Finding, IntentRecord, ReconcilerSpec, TickRecord } from '../src/core/types.js';

const finding: Finding = { id: 'f', kind: 'k', severity: 'blocking', summary: '', data: {} };

test('repeating itself: a lost action re-proposed under the same key is escalated on the spot', async () => {
  const sim = new Sim();
  const performed: string[] = [];
  const trace: TickRecord[] = [];
  sim.register('w', (rt) => reconcile(rt, {
    name: 'stall', budget: { maxDurationMs: 6 * HOUR, maxAttemptsPerFinding: 3 },
    observe: async () => ({ world: {}, findings: [finding], blockers: [] }),
    done: () => undefined,
    plan: () => ({ actions: [{ key: 'reply:f', kind: 'reply', targets: ['f'], deadlineMs: HOUR }], wake: { afterMs: 2 * HOUR } }),
    act: async (a) => { performed.push(a.key); },
  }, { onTick: (r) => trace.push(r) }));
  sim.start('w', 'w', {});
  await sim.run();
  assert.equal(sim.result<any>('w').status, 'out-of-time');
  // The reply ran once; its deadline passed; the plan re-proposed the same key: escalate, don't end.
  assert.equal(performed.filter((k) => k === 'reply:f').length, 1);
  const stalled = trace.find((r) => r.stalled.length)!;
  assert.deepEqual(stalled.stalled, ['f']);
  assert.deepEqual(stalled.acted, ['escalate:f:2']);
  assert.ok(stalled.at <= 2 * HOUR, `escalated at ${stalled.at / HOUR}h`);
});

test('a plan that acts every tick against an unchanging world polls instead of spinning', async () => {
  const sim = new Sim();
  const trace: TickRecord[] = [];
  sim.register('w', (rt) => reconcile(rt, {
    name: 'spin', budget: { maxDurationMs: 2 * DAY },
    observe: async () => ({ world: {}, findings: [], blockers: [] }),
    done: () => undefined,
    plan: (f) => ({ actions: [{ key: `start:B-1@${f.tick}`, kind: 'start' }], wake: { afterMs: HOUR } }),
    act: async () => {},
  }, { onTick: (r) => trace.push(r) }));
  sim.start('w', 'w', {});
  await sim.run();
  assert.equal(sim.result<any>('w').status, 'out-of-time');
  assert.equal(trace.filter((r) => r.at === 0).length, 11, 'start tick + 10 immediate re-ticks, then the plan wake');
  assert.ok(trace.length < 11 + 2 * 24 + 2, `${trace.length} ticks`);
});


// ───────────────────────────── escalation, aging, retention (frame level) ─────────────────────────────

const B: Budget = { maxAttemptsPerFinding: 3, maxFindingAgeMs: 7 * DAY, retentionMs: 30 * DAY, escalationDeadlineMs: HOUR };
const breach: Finding = { id: 'breach:latency_p99', kind: 'breach', severity: 'blocking', summary: '', data: {} };
const entry = (key: string, at: number, kind = 'fix', settled = true): IntentRecord =>
  ({ key, kind, targets: [breach.id], at, tick: 0, deadlineMs: HOUR, settled, handedOff: settled });
const seen = (blockers: Blocker[] = []) => ({ world: {}, findings: [breach], blockers });
const blocker = (b: Partial<Blocker>): Blocker => ({ id: 'issue:1', kind: 'issue', on: [breach.id], scope: 'loop', summary: '', ...b });

test('out of attempts: the finding is escalated and taken out of open', () => {
  const m = newMemory(0);
  m.intents = [entry('fix:1', 1 * DAY), entry('fix:2', 2 * DAY), entry('fix:3', 3 * DAY)];
  const f = buildFrame(seen(), m, 4 * DAY, B);
  assert.equal(f.escalating.length, 1);
  assert.match(f.escalating[0]!.reason, /3 attempts/);
  assert.equal(f.open.length, 0);
  assert.equal(escalation(f.escalating[0]!, f, B).key, 'escalate:breach:latency_p99:4');
});

test('an escalation in flight (not yet in the world) claims the finding; it is not escalated again', () => {
  const m = newMemory(0);
  m.intents = [entry('fix:1', 1 * DAY), entry('fix:2', 2 * DAY), entry('fix:3', 3 * DAY), entry('escalate:4', 4 * DAY, 'escalate', false)];
  const f = buildFrame(seen(), m, 4 * DAY + MIN, B);
  assert.equal(f.escalating.length, 0);
  assert.deepEqual(f.claimed.map((x) => x.id), [breach.id]);
});

test('after a person resolves an escalation, the agent gets a fresh set of attempts', () => {
  const m = newMemory(0);
  m.intents = [entry('fix:1', 1 * DAY), entry('fix:2', 2 * DAY), entry('fix:3', 3 * DAY), entry('escalate:4', 4 * DAY, 'escalate')];
  let f = buildFrame(seen(), m, 5 * DAY, B);
  assert.equal(f.escalating.length, 0);
  assert.deepEqual(f.open.map((x) => x.id), [breach.id]);
  assert.equal(f.attempts[breach.id], 4, 'the next key uses attempt 5');
  m.intents.push(entry('fix:5', 5 * DAY), entry('fix:6', 5.1 * DAY), entry('fix:7', 5.2 * DAY));
  f = buildFrame(seen(), m, 5.3 * DAY, B);
  assert.equal(escalation(f.escalating[0]!, f, B).key, 'escalate:breach:latency_p99:8');
});

test('too old: blocked 8 days by an obligation the loop never filed is escalated, and stays blocked', () => {
  const f = buildFrame(seen([blocker({ since: 0 })]), newMemory(0), 8 * DAY, B);
  assert.equal(f.escalating.length, 1);
  assert.match(f.escalating[0]!.reason, /8 days/);
  assert.deepEqual(f.blocked.map((x) => x.id), [breach.id]);
});

test('waiting on a prerequisite, or queued without an action, does not age a finding', () => {
  let f = buildFrame(seen([blocker({ id: 'needs:dep', scope: 'finding', since: 0, prerequisite: true })]), newMemory(0), 30 * DAY, B);
  assert.equal(f.escalating.length, 0);
  assert.deepEqual(f.blocked.map((x) => x.id), [breach.id]);
  f = buildFrame(seen(), newMemory(0), 30 * DAY, B);
  assert.equal(f.escalating.length, 0);
  assert.deepEqual(f.open.map((x) => x.id), [breach.id]);
});

test('retention forgets old settled entries and judgments, but attempt numbers keep counting up', () => {
  const m = newMemory(0);
  m.intents = [entry('fix:1', 1 * DAY), entry('fix:2', 2 * DAY), entry('fix:3', 40 * DAY)];
  m.memo['triage:x:1'] = { value: 'quick-fix', at: 1 * DAY };
  forget(m, 45 * DAY, B);
  assert.equal(m.intents.length, 1);
  assert.deepEqual(m.forgotten[breach.id], { count: 2, lastAt: 2 * DAY });
  assert.equal(m.memo['triage:x:1'], undefined);
  const f = buildFrame(seen(), m, 45 * DAY, B);
  assert.equal(f.attempts[breach.id], 3, 'the next key is :4, never a repeat of :1 or :2');
  assert.equal(f.escalating.length, 0, 'only one attempt is left in the window');
});

test('memory written before escalation (v1) is migrated when it is read', () => {
  const v1: LoopMemoryV1 = {
    version: 1, startedAt: 0, tick: 7, actions: 2, cost: 0, memo: { 'triage:b:1': 'quick-fix' },
    intents: [
      { key: 'fix:b:1', kind: 'submit-fix', targets: ['b'], at: 10, tick: 3, settle: { kind: 'handoff', ttlMs: HOUR }, handedOff: true, settled: false },
      { key: 'rollback:b:1', kind: 'rollback', targets: [], at: 10, tick: 3, settle: { kind: 'immediate' }, settled: true },
    ],
  };
  const m = migrate(v1, 99);
  assert.equal(m.version, 2);
  assert.deepEqual(m.intents.map((i) => i.deadlineMs), [HOUR, undefined]);
  assert.equal(m.intents[0]!.handedOff, true);
  assert.deepEqual(m.memo, { 'triage:b:1': { value: 'quick-fix', at: 99 } });
  assert.deepEqual(m.forgotten, {});
  assert.equal(m.tick, 7);
});

// ───────────────────────────── a loop with no end ─────────────────────────────

/**
 * An on-call style loop: no goal, no time budget. A new incident appears every day; a fix
 * clears it once its CL rolls out, except every 10th incident, which no fix clears. The
 * person it is escalated to hands the first escalation back unfixed, and fixes it the second time.
 */
function onCallLoop(sim: Sim) {
  const resolved = new Set<string>();
  const rolling = new Map<string, number>(); // finding -> its CL is live at
  const withPerson = new Map<string, { since: number; until: number }>();
  const escalations = new Map<string, number>();
  const stubborn = (id: string) => Number(id.split(':')[1]) % 10 === 9;
  const spec: ReconcilerSpec<{}, Finding, Action> = {
    name: 'on-call',
    budget: { maxAttemptsPerFinding: 3, maxFindingAgeMs: 7 * DAY, retentionMs: 30 * DAY, escalationDeadlineMs: HOUR },
    async observe({ memo }) {
      for (const [id, live] of rolling) if (sim.now >= live) { rolling.delete(id); if (!stubborn(id)) resolved.add(id); }
      for (const [id, p] of withPerson) if (sim.now >= p.until) withPerson.delete(id);
      const findings = Array.from({ length: Math.floor(sim.now / DAY) + 1 }, (_, d) => `incident:${d}`)
        .filter((id) => !resolved.has(id))
        .map((id) => ({ id, kind: 'incident', severity: 'blocking' as const, summary: '', data: {} }));
      for (const f of findings) await memo.get(`triage:${f.id}`, async () => 'quick-fix');
      return {
        world: {}, findings,
        blockers: [
          ...[...rolling.keys()].map((id) => ({ id: `cl:${id}`, kind: 'deploy', on: [id], scope: 'finding' as const, summary: '' })),
          ...[...withPerson].map(([id, p]) => ({ id: `issue:${id}`, kind: 'person', on: [id], scope: 'finding' as const, summary: '', since: p.since })),
        ],
      };
    },
    plan: (f) => ({
      actions: f.open.map((x) => ({ key: `fix:${x.id}:${(f.attempts[x.id] ?? 0) + 1}`, kind: 'fix', targets: [x.id], deadlineMs: HOUR })),
      wake: { afterMs: 4 * HOUR },
    }),
    async act(a) {
      const id = a.targets![0]!;
      if (a.kind === 'fix') rolling.set(id, sim.now + 2 * HOUR);
      if (a.kind === 'escalate') {
        const n = (escalations.get(id) ?? 0) + 1;
        escalations.set(id, n);
        withPerson.set(id, { since: sim.now, until: sim.now + DAY });
        if (n >= 2) sim.timer(DAY - MIN, () => resolved.add(id));
      }
    },
  };
  return { spec, resolved, escalations };
}

test('a loop with no goal and no time budget runs for a simulated year with bounded memory', async () => {
  const sim = new Sim();
  const { spec, resolved, escalations } = onCallLoop(sim);
  const sizes: { at: number; bytes: number; intents: number }[] = [];
  const keys: string[] = [];
  sim.register('w', (rt) => reconcileToEnd(rt, spec, {
    maxTicksPerRun: 50,
    onTick: (r) => keys.push(...r.acted),
    onCheckpoint: (m) => sizes.push({ at: rt.now(), bytes: JSON.stringify(m).length, intents: m.intents.length }),
  }));
  sim.start('w', 'w', {});
  await sim.run({ until: () => sim.now >= 365 * DAY });
  assert.equal(sim.status('w'), 'running', 'still running after a year');

  // Every ordinary incident was fixed; every stubborn one went to a person twice, then was fixed.
  assert.ok(resolved.size >= 360, `${resolved.size} resolved`);
  assert.ok(escalations.size >= 35, `${escalations.size} escalated`);
  assert.ok([...escalations.values()].every((n) => n <= 2));
  // After the first escalation came back unresolved, the agent got fresh attempts: 1-3, escalate 4, 5-7, escalate 8.
  assert.deepEqual(keys.filter((x) => x.includes(':incident:9:')), [
    'fix:incident:9:1', 'fix:incident:9:2', 'fix:incident:9:3', 'escalate:incident:9:4',
    'fix:incident:9:5', 'fix:incident:9:6', 'fix:incident:9:7', 'escalate:incident:9:8',
  ]);
  assert.equal(new Set(keys).size, keys.length, 'no key was ever reused');

  // Memory stops growing once retention kicks in.
  const late = sizes.filter((s) => s.at > 90 * DAY);
  const maxIntents = Math.max(...late.map((s) => s.intents));
  const maxBytes = Math.max(...late.map((s) => s.bytes));
  assert.ok(maxIntents <= 80, `${maxIntents} ledger entries`);
  assert.ok(maxBytes <= 32_000, `${maxBytes} bytes`);
});
