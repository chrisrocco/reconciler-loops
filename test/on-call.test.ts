import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, DAY, HOUR } from '../src/runtime/sim.js';
import { onCallWorkflow } from '../src/scenarios/on-call.js';
import { OnCallWorld } from '../src/fakes/on-call-world.js';
import type { TickRecord } from '../src/core/types.js';

const WF = 'oncall:infra';

async function run(seed: number, days = 90) {
  const sim = new Sim();
  const world = new OnCallWorld(sim, seed, days);
  const trace: TickRecord[] = [];
  const sizes: number[] = [];
  sim.register('oncall', (rt, input) => onCallWorkflow(rt, rt.activities(world.activities()), input, {
    onTick: (r) => trace.push(r), onCheckpoint: (m) => sizes.push(JSON.stringify(m).length),
  }));
  sim.start(WF, 'oncall', { team: 'infra' });
  await sim.run({ until: () => sim.now >= days * DAY });
  return { sim, world, trace, sizes };
}

test('on-call: no goal, no time budget — it keeps builds green and releases moving for 90 days', async () => {
  const { sim, world, trace, sizes } = await run(1);
  assert.equal(sim.status(WF), 'running', 'still running');
  assert.ok(world.stats.breaks >= 20 && world.stats.wrongSuspect >= 3 && world.stats.badReleases >= 5, JSON.stringify(world.stats));

  // Every breakage was mitigated within two hours, the wrongly blamed ones included: the loop
  // reverted the next suspect itself instead of waiting days for the owner.
  const closed = world.redSpans.filter((s) => s.to !== undefined);
  assert.ok(closed.length >= world.redSpans.length - 1, 'every red target went green (bar one still in flight)');
  for (const s of closed) assert.ok(s.to! - s.from <= 2 * HOUR, `${s.target} red for ${((s.to! - s.from) / HOUR).toFixed(1)}h`);
  assert.ok(trace.some((r) => r.acted.some((k) => k.startsWith('revert:')) && r.blocked.some((f) => f.startsWith('build:'))), 'reverted a second suspect while the issue was open');

  // No release was promoted while an alert fired on it.
  for (const r of world.releases.filter((r) => r.state !== 'canary' && r.state !== 'paused')) assert.equal(r.alerts.length, 0);

  // Issues their owners ignored were escalated after the 3-day age limit, and the lead fixed them.
  assert.ok(world.stats.ignored > 0 && world.stats.leadFixes > 0);
  assert.ok([...world.issues.values()].filter((i) => i.escalated).every((i) => i.status === 'closed' || sim.now - i.createdAt < 5 * DAY));
  const stale = [...world.issues.values()].filter((i) => i.status === 'open' && !i.escalated && sim.now - i.createdAt > 4 * DAY);
  assert.deepEqual(stale.map((i) => i.id), [], 'no issue sits forgotten');

  // Memory stays bounded by retention.
  assert.ok(Math.max(...sizes.slice(-5)) < 40_000, `${Math.max(...sizes)} bytes`);
});

test('on-call: reproducible from the seed, and different seeds tell different stories', async () => {
  const a = await run(3, 30), b = await run(3, 30), c = await run(4, 30);
  assert.deepEqual(a.trace.map((r) => r.acted), b.trace.map((r) => r.acted));
  assert.notDeepEqual(a.world.stats, c.world.stats);
});
