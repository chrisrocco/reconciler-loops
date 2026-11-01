/**
 * Prints a frame-by-frame timeline of the experiment loop with a recursive
 * investigation (child bug → grandchild bug). Run: npx tsx examples/experiment-timeline.ts
 */
import { Sim, fmt } from '../src/runtime/sim.js';
import { ProdWorld, STANDARD_RAMP } from '../src/fakes/prod-world.js';
import { experimentWorkflow } from '../src/scenarios/experiment.js';
import { investigationWorkflow } from '../src/scenarios/investigation.js';
import type { TickRecord } from '../src/core/types.js';

const sim = new Sim();
const world = new ProdWorld(sim);
world.addExperiment('E1', STANDARD_RAMP);
world.addDefect({ id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', severity: 'severe', triggerStage: 2, route: 'investigate', analysisHours: 20, requires: 'D3' });
world.addDefect({ id: 'D3', signature: 'stale FX rates in pricing-svc', route: 'investigate', analysisHours: 10 });

const lines: string[] = [];
const onTick = (wf: string) => (r: TickRecord) => {
  const interesting = r.acted.length || r.woke?.startsWith('signal') || r.tick === 0;
  if (!interesting) return;
  const pad = wf.startsWith('experiment') ? '' : wf.split(':')[1] === 'B-1' ? '    ' : '        ';
  lines.push(
    `${fmt(r.at)} ${pad}[${wf}] t${r.tick} woke=${r.woke}` +
    (r.findings.length ? ` findings=${r.findings.join(',')}` : '') +
    (r.blockers.length ? ` blockers=${r.blockers.join(',')}` : '') +
    (r.acted.length ? `\n${' '.repeat(10)}${pad}→ ${r.acted.join(' | ')}` : ''),
  );
};
sim.register('experiment', (rt, i) => experimentWorkflow(rt, rt.activities(world.activities()), i, { onTick: onTick(rt.workflowId) }));
sim.register('investigation', (rt, i) => investigationWorkflow(rt, rt.activities(world.activities()), i, { onTick: onTick(rt.workflowId) }));
sim.start('experiment:checkout_v2', 'experiment', { flagName: 'checkout_v2' });
await sim.run();

console.log(lines.join('\n'));
console.log(`\nresult: ${JSON.stringify(sim.result('experiment:checkout_v2'))} at ${fmt(sim.now)}`);
console.log('stage history:', world.exps.get('E1')!.history.map((h) => `${fmt(h.at)}→${STANDARD_RAMP[h.stage]!.percent}%`).join('  '));
