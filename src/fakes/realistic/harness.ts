/** Run one catalog scenario in the realistic world from a seed. Used by tests and the report. */
import { DEFAULT_RETRY, Sim } from '../../runtime/sim.js';
import type { TickRecord } from '../../core/types.js';
import { experimentWorkflow } from '../../scenarios/experiment.js';
import { investigationWorkflow } from '../../scenarios/investigation.js';
import { RAMP_POLICIES } from '../prod-world.js';
import type { Scenario } from '../catalog.js';
import { RealisticWorld } from './world.js';

export const EXP = 'experiment:checkout_v2';

export interface RealisticRun {
  sim: Sim;
  world: RealisticWorld;
  trace: (TickRecord & { wf: string })[];
  result?: { status: string; reason?: string };
  error?: string;
}

export async function runRealistic(scenario: Scenario, seed: number, rampPolicy = scenario.rampPolicy ?? 'standard'): Promise<RealisticRun> {
  const sim = new Sim();
  const world = new RealisticWorld(sim, seed);
  world.addExperiment('E1', RAMP_POLICIES[rampPolicy]!, { arms: scenario.arms });
  scenario.defects.forEach((d) => world.addDefect(d));
  const trace: RealisticRun['trace'] = [];
  const onTick = (wf: string) => (r: TickRecord) => trace.push({ ...r, wf });
  sim.register('experiment', (rt, input) =>
    experimentWorkflow(rt, rt.activities(world.activities(), DEFAULT_RETRY), input, { onTick: onTick(rt.workflowId), maxTicksPerRun: scenario.maxTicksPerRun }));
  sim.register('investigation', (rt, input) =>
    investigationWorkflow(rt, rt.activities(world.activities(), DEFAULT_RETRY), input, { onTick: onTick(rt.workflowId) }));
  const start = () => { sim.start(EXP, 'experiment', { flagName: 'checkout_v2', maxInvestigationDepth: scenario.maxDepth ?? 3, maxDurationMs: scenario.maxDurationMs }); };
  scenario.setup?.({ sim, world, start });
  start();
  let error: string | undefined;
  try { await sim.run(); } catch (e) { error = String(e); }
  return { sim, world, trace, result: sim.result(EXP), error };
}
