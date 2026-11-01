/**
 * Seed sweep in the realistic world: noisy metrics, lagging search, ambiguous creates,
 * slow human review and weekday rollouts, wrong agents. Outcomes vary by seed; the
 * framework's guarantees must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realisticScenarios } from '../src/fakes/catalog.js';
import { EXP, runRealistic, type RealisticRun } from '../src/fakes/realistic/harness.js';
import { OPEN } from '../src/fakes/realistic/bug-tracker.js';

const SEEDS = 20;
const TERMINAL = new Set(['done', 'out-of-time', 'escalated', 'failed']);

function checkInvariants(r: RealisticRun, label: string) {
  assert.equal(r.error, undefined, `${label}: simulation error`);
  assert.ok(r.result && TERMINAL.has(r.result.status), `${label}: ended ${JSON.stringify(r.result)}`);
  assert.equal(r.sim.status(EXP), 'completed', `${label}: experiment workflow ${r.sim.status(EXP)}`);

  // The loop never advanced while a frame it saw was held.
  for (const t of r.trace.filter((t) => t.wf === EXP && t.held))
    assert.ok(!t.acted.some((k) => k.startsWith('advance') || k === 'conclude'), `${label}: advanced while held at tick ${t.tick}`);

  // Ground truth, not just what the loop saw: no advance while one of its bugs was really open.
  const exp = r.world.exps.get('E1')!;
  const issues = [...r.world.tracker.issues.values()].filter((i) => i.fields.parent === 'exp:checkout_v2');
  for (const h of exp.history.filter((h) => h.key.includes('/advance') || h.key.includes('conclude')))
    for (const i of issues) {
      const closedAt = r.world.tracker.canonical(i.id).closedAt ?? Infinity;
      assert.ok(!(h.at >= i.createdAt && h.at < closedAt), `${label}: ${h.key} while ${i.id} was open`);
    }

  // A finished ramp leaves no open obligations behind.
  if (r.result!.status === 'done') {
    for (const i of issues) assert.ok(!OPEN.has(r.world.tracker.canonical(i.id).status), `${label}: done with ${i.id} open`);
    for (const p of r.world.pages.values()) assert.equal(p.status, 'resolved', `${label}: done with page ${p.id} open`);
  }

  // No advance while a page was open.
  for (const h of exp.history.filter((h) => h.key.includes('/advance') || h.key.includes('conclude')))
    for (const p of r.world.pages.values())
      assert.ok(!(h.at >= p.openedAt && h.at < (p.resolvedAt ?? Infinity)), `${label}: ${h.key} while page ${p.id} was open`);

  // Every investigation this run started has finished.
  for (const i of r.world.tracker.issues.values()) {
    const s = r.sim.status(`investigate:${i.id}`);
    assert.ok(s === 'unknown' || s === 'completed', `${label}: investigate:${i.id} is ${s}`);
  }
}

for (const sc of realisticScenarios()) {
  test(`realistic sweep: ${sc.title} (${SEEDS} seeds) keeps every invariant`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) checkInvariants(await runRealistic(sc, seed), `${sc.id} seed ${seed}`);
  });
}

test('realistic runs are reproducible from the seed', async () => {
  const a = await runRealistic(realisticScenarios()[0]!, 7), b = await runRealistic(realisticScenarios()[0]!, 7);
  assert.equal(a.sim.now, b.sim.now);
  assert.deepEqual(a.world.stats, b.world.stats);
  assert.deepEqual(a.trace.map((t) => t.acted), b.trace.map((t) => t.acted));
});

test('the realistic world actually exercises its imperfections', async () => {
  const totals: Record<string, number> = {};
  for (const sc of realisticScenarios())
    for (let seed = 1; seed <= SEEDS; seed++)
      for (const [k, v] of Object.entries((await runRealistic(sc, seed)).world.stats)) totals[k] = (totals[k] ?? 0) + v;
  for (const k of ['rpcErrors', 'ambiguousCreates', 'statusLag', 'staleReadouts', 'falseAlarms', 'misroutes', 'rcaInconclusive',
    'fixesIneffective', 'verifyWrong', 'duplicateBugs', 'humanInterventions', 'pages', 'presubmitFlakes', 'reviewRounds', 'releaseRollbacks'])
    assert.ok(totals[k]! > 0, `${k} never happened across the sweep`);
});
