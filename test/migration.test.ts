import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, DAY } from '../src/runtime/sim.js';
import { campaignWorkflow, componentMigrationWorkflow } from '../src/scenarios/migration.js';
import { MigrationWorld, SAMPLE_APP } from '../src/fakes/migration-world.js';
import type { TickRecord } from '../src/core/types.js';

const CAMPAIGN = 'campaign:new-ui';

function run(o: { maxInFlight?: number; maxPerOwner?: number } = {}) {
  const sim = new Sim();
  const world = new MigrationWorld(sim, SAMPLE_APP);
  const trace: (TickRecord & { wf: string })[] = [];
  const onTick = (wf: string) => (r: TickRecord) => trace.push({ ...r, wf });
  sim.register('campaign', (rt, input) => campaignWorkflow(rt, rt.activities(world.activities()), input, { onTick: onTick(rt.workflowId) }));
  sim.register('component-migration', (rt, input) => componentMigrationWorkflow(rt, rt.activities(world.activities()), input, { onTick: onTick(rt.workflowId) }));
  sim.start(CAMPAIGN, 'campaign', { name: 'new-ui', maxInFlight: o.maxInFlight ?? 4, maxPerOwner: o.maxPerOwner ?? 2 });
  return { sim, world, trace };
}

test('migration: the campaign moves every component, then removes the old framework', async () => {
  const { sim, world, trace } = run();
  await sim.run();
  assert.equal((sim.result(CAMPAIGN) as any).status, 'done');
  assert.equal(world.legacy.size, 0);
  assert.ok(world.cleanup.startedAt! >= Math.max(...world.migrated.map((m) => m.at)), 'cleanup only once nothing was left');
  assert.deepEqual(world.allowlist, [], 'the allowlist shrank as components moved');

  const by = Object.fromEntries(world.migrated.map((m) => [m.path, m.by]));
  assert.equal(by['ui/DatePicker'], 'team', 'the hard one was escalated to its team');
  assert.equal(by['account/Settings'], 'person', 'migrated by hand, and the campaign simply saw it');
  assert.ok(![...world.changes.values()].some((c) => c.path === 'account/Settings'), 'never started a migration for it');
  assert.ok(Object.entries(by).filter(([, b]) => b === 'agent').length >= 11);

  // The churning component was converted again after it changed underneath its review.
  assert.ok(trace.some((r) => r.wf === 'migrate:checkout/Cart' && r.acted.some((k) => k.startsWith('convert:conflict@'))));
  // Failing checks were fixed with attempt numbers in the keys.
  assert.ok(trace.some((r) => r.wf === 'migrate:ui/Input' && r.acted.includes('fix:check:tests:2')));
});

test('migration: work-in-progress limits and prerequisites are respected at every moment', async () => {
  const { sim, world, trace } = run({ maxInFlight: 4, maxPerOwner: 2 });
  await sim.run();
  const changes = [...world.changes.values()];
  const migratedAt = (p: string) => world.migrated.find((m) => m.path === p)?.at ?? Infinity;
  // Never more than 4 agent migrations in flight, nor 2 per owner.
  const events = changes.flatMap((c) => [c.createdAt, ...(c.withTeam ? [c.withTeam.since] : [])]);
  for (const t of events) {
    const active = changes.filter((c) => c.createdAt <= t && migratedAt(c.path) > t && !(c.withTeam && c.withTeam.since <= t));
    assert.ok(active.length <= 4, `${active.length} in flight at ${t}`);
    for (const owner of new Set(active.map((c) => c.owner))) assert.ok(active.filter((c) => c.owner === owner).length <= 2);
  }
  // No component started before everything it uses had moved.
  for (const c of changes.filter((c) => !c.withTeam || c.rev > 0)) {
    const spec = SAMPLE_APP.find((s) => s.path === c.path)!;
    for (const dep of spec.uses ?? []) assert.ok(migratedAt(dep) <= c.createdAt, `${c.path} started before ${dep} moved`);
  }
  // Waiting on prerequisites never counted as age: nothing but the hard component was escalated.
  const escalated = trace.filter((r) => r.acted.some((k) => k.startsWith('escalate:'))).map((r) => r.wf);
  assert.deepEqual([...new Set(escalated)], ['migrate:ui/DatePicker']);
  assert.ok(sim.now < 60 * DAY);
});
