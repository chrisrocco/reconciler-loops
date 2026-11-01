/**
 * Runs one scenario on the virtual-time simulator and records everything the UI plays
 * back: every tick of every loop, workflow runs, the systems of record, and readings.
 * The world is the seeded realistic one: the same scenario and seed always replay the same way.
 */
import { DEFAULT_RETRY, Sim } from '../../../../src/runtime/sim';
import { Terminated } from '../../../../src/core/runtime';
import { RAMP_POLICIES } from '../../../../src/fakes/prod-world';
import { RealisticWorld, type WorldStats } from '../../../../src/fakes/realistic/world';
import { experimentWorkflow, type ExperimentActivities, type GuardrailReading } from '../../../../src/scenarios/experiment';
import { investigationWorkflow, type InvestigationActivities } from '../../../../src/scenarios/investigation';
import type { PageView } from '../../../../src/scenarios/systems';
import type { TickRecord } from '../../../../src/core/types';
import type { Scenario } from '../../../../src/fakes/catalog';

export const EXP = 'experiment:checkout_v2';

import type { Lane, LogEvent, Tick, WorkflowRun } from '../trace';
export type { EventKind, Lane, LogEvent, Tick, WorkflowRun } from '../trace';
export interface BugRow {
  id: string; title: string; parent: string; depth: number; createdAt: number; closedAt?: number;
  /** Tracker status as the tracker shows it (open/fixed/wontfix, or e.g. DUPLICATE, INTENDED_BEHAVIOR). */
  status: string; duplicateOf?: string; closedBy?: string; notes: string[];
}
export interface FixPhase { label: string; from: number; to?: number }
export interface FixRow {
  id: string; parent: string; finding: string; ref: string; author?: string; state?: string;
  submittedAt: number; inProdAt?: number; phases?: FixPhase[];
}
export interface Reading { at: number; readings: GuardrailReading[] }

export interface SimRun {
  scenario: Scenario;
  seed: number;
  end: number;
  result: { status: string; reason?: string } | undefined;
  lanes: Lane[];
  /** Stage changes; in a multi-arm experiment, one series per arm. */
  stages: { at: number; percent: number; key: string; arm?: string }[];
  rampPolicy: string;
  bugs: BugRow[];
  fixes: FixRow[];
  readings: Reading[];
  escalations: string[];
  pages: PageView[];
  outages: { from: number; to: number }[];
  stats: WorldStats;
  events: LogEvent[];
  error?: string;
}

export async function runScenario(scenario: Scenario, seed = 1, rampPolicy = scenario.rampPolicy ?? 'standard'): Promise<SimRun> {
  const sim = new Sim();
  const world = new RealisticWorld(sim, seed);
  world.addExperiment('E1', RAMP_POLICIES[rampPolicy]!, { arms: scenario.arms });
  scenario.defects.forEach((d) => world.addDefect(d));

  const runs = new Map<string, WorkflowRun[]>();
  const ticks = new Map<string, Tick[]>();
  const readings: Reading[] = [];

  const activities = (): ExperimentActivities & InvestigationActivities => {
    const acts = world.activities();
    const read = acts.readGuardrails;
    acts.readGuardrails = async (id) => {
      const r = await read(id);
      readings.push({ at: sim.now, readings: r });
      return r;
    };
    return acts;
  };
  const onTick = (wf: string) => (r: TickRecord) => {
    const list = ticks.get(wf) ?? [];
    ticks.set(wf, list);
    list.push({ ...r, wf, idx: list.length });
  };
  // Record each run's start and end, including a termination.
  const tracked = <I>(fn: (rt: any, input: I) => Promise<{ status: string }>) => async (rt: any, input: I) => {
    const list = runs.get(rt.workflowId) ?? [];
    runs.set(rt.workflowId, list);
    const run: WorkflowRun = { start: sim.now };
    list.push(run);
    try {
      const out = await fn(rt, input);
      Object.assign(run, { end: sim.now, outcome: out.status });
      return out;
    } catch (e) {
      Object.assign(run, { end: sim.now, outcome: e instanceof Terminated ? 'terminated' : 'failed' });
      throw e;
    }
  };

  sim.register('experiment', tracked((rt, input) =>
    experimentWorkflow(rt, rt.activities(activities(), DEFAULT_RETRY), input, { onTick: onTick(rt.workflowId), maxTicksPerRun: scenario.maxTicksPerRun })));
  sim.register('investigation', tracked((rt, input) =>
    investigationWorkflow(rt, rt.activities(activities(), DEFAULT_RETRY), input, { onTick: onTick(rt.workflowId) })));

  const start = () => { sim.start(EXP, 'experiment', { flagName: 'checkout_v2', maxInvestigationDepth: scenario.maxDepth ?? 3, maxDurationMs: scenario.maxDurationMs }); };
  scenario.setup?.({ sim, world, start });
  start();

  let error: string | undefined;
  try { await sim.run(); } catch (e) { error = String(e); }

  const snap = snapshot(world);
  const depthOf = (wf: string) => (wf === EXP ? 0 : snap.bugs.find((b) => `investigate:${b.id}` === wf)?.depth ?? 1);
  const lanes: Lane[] = [...runs.keys()]
    .map((wf) => ({ wf, depth: depthOf(wf), runs: runs.get(wf)!, ticks: ticks.get(wf) ?? [] }))
    .sort((a, b) => (a.wf === EXP ? -1 : b.wf === EXP ? 1 : a.runs[0]!.start - b.runs[0]!.start));
  const end = Math.max(sim.now, ...lanes.flatMap((l) => l.runs.map((r) => r.end ?? 0)));
  const outages = snap.outages.filter((o) => o.from < end);

  return {
    ...snap, scenario, seed, rampPolicy, end, result: sim.result(EXP), lanes, readings, outages, error,
    events: buildEvents(lanes, snap.stages, snap.bugs, snap.fixes, snap.escalations, snap.pages, outages, end),
  };
}

function snapshot(w: RealisticWorld) {
  const s = w.snapshot('E1');
  const closedBy = (id: string) => w.tracker.issues.get(id)?.closedBy;
  return { ...s, bugs: s.bugs.map((b): BugRow => ({ ...b, closedBy: closedBy(b.id) })) };
}

function buildEvents(
  lanes: Lane[], stages: SimRun['stages'], bugs: BugRow[], fixes: FixRow[], escalations: string[], pages: PageView[],
  outages: SimRun['outages'], end: number,
): LogEvent[] {
  const ev: LogEvent[] = [];
  for (const l of lanes) {
    l.runs.forEach((r, i) => {
      ev.push({ at: r.start, wf: l.wf, kind: 'run', text: l.runs.length > 1 ? `run #${i + 1} started` : 'started' });
      if (r.end !== undefined) ev.push({ at: r.end, wf: l.wf, kind: r.outcome === 'terminated' ? 'outcome' : 'run', text: r.outcome === 'terminated' ? 'TERMINATED: workflow memory is gone' : `finished: ${r.outcome}` });
    });
    for (const t of l.ticks) {
      if (t.woke?.startsWith('signal:')) ev.push({ at: t.at, wf: l.wf, kind: 'signal', text: `woken by hint "${t.woke.slice(7)}"` });
      for (const k of t.acted) ev.push({ at: t.at, wf: l.wf, kind: 'action', text: `→ ${k}` });
    }
  }
  for (const s of stages.slice(1)) {
    const why = s.key.includes('safe-hold') ? 'safe-hold' : s.key.includes('rollback') ? 'rollback' : 'advance';
    ev.push({ at: s.at, wf: 'experiments', kind: 'stage', text: `rollout ${why} → ${s.percent}%` });
  }
  for (const b of bugs) {
    ev.push({ at: b.createdAt, wf: 'tracker', kind: 'bug', text: `filed ${b.id}: ${b.title} (parent ${b.parent})` });
    if (b.closedAt !== undefined) {
      const what = b.status === 'DUPLICATE' ? `marked ${b.id} duplicate of ${b.duplicateOf}` : `closed ${b.id} ${b.status}`;
      ev.push({ at: b.closedAt, wf: 'tracker', kind: 'bug', text: `${what}${b.closedBy && b.closedBy !== 'agent' ? ` by ${b.closedBy}` : ''}` });
    }
  }
  const notable = /rolled back|abandoned|failed|rerun/;
  for (const f of fixes) {
    ev.push({ at: f.submittedAt, wf: 'review', kind: 'deploy', text: `${f.author === 'human' ? 'human uploaded' : 'uploaded'} ${f.id} for ${f.parent}` });
    for (const p of f.phases ?? []) if (notable.test(p.label)) ev.push({ at: p.from, wf: 'release', kind: 'world', text: `${f.id}: ${p.label}` });
    if (f.inProdAt !== undefined && f.inProdAt <= end) ev.push({ at: f.inProdAt, wf: 'release', kind: 'deploy', text: `${f.id} fully rolled out` });
  }
  for (const p of pages) {
    ev.push({ at: p.openedAt, wf: 'pager', kind: 'outcome', text: `paged on-call (${p.id}): ${p.reason}` });
    if (p.resolvedAt !== undefined) ev.push({ at: p.resolvedAt, wf: 'pager', kind: 'world', text: `${p.id} resolved by on-call: ${p.resolution}` });
  }
  for (const o of outages) ev.push({ at: o.from, wf: 'metrics', kind: 'world', text: 'analysis pipeline stalled; results going stale' });
  const expEnd = lanes.find((l) => l.wf === EXP)?.runs.at(-1)?.end;
  for (const e of escalations) ev.push({ at: expEnd ?? end, wf: EXP, kind: 'outcome', text: `escalated: ${e}` });
  return ev.sort((a, b) => a.at - b.at);
}
