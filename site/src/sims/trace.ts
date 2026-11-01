/**
 * Recording a simulation for playback: every tick of every loop, each workflow run, snapshots
 * of the world, and an event log. Shared by every simulation on the site.
 */
import { Terminated } from '../../../src/core/runtime';
import type { TickRecord } from '../../../src/core/types';
import type { Sim } from '../../../src/runtime/sim';

export type Tick = TickRecord & { wf: string; idx: number };
export interface WorkflowRun { start: number; end?: number; outcome?: string }
export interface Lane { wf: string; depth: number; runs: WorkflowRun[]; ticks: Tick[] }
export type EventKind = 'run' | 'action' | 'signal' | 'stage' | 'bug' | 'deploy' | 'outcome' | 'world';
export interface LogEvent { at: number; wf: string; kind: EventKind; text: string }

export interface TraceRun<S> {
  lanes: Lane[];
  end: number;
  events: LogEvent[];
  /** World snapshots, in time order: the world panel shows the last one at or before the playhead. */
  snapshots: { at: number; s: S }[];
  result?: { status: string; reason?: string };
  error?: string;
}

export class Recorder<S> {
  readonly runs = new Map<string, WorkflowRun[]>();
  readonly ticks = new Map<string, Tick[]>();
  readonly snapshots: { at: number; s: S }[] = [];

  constructor(private sim: Sim, private snapshot: () => S) {}

  onTick = (wf: string) => (r: TickRecord) => {
    const list = this.ticks.get(wf) ?? [];
    this.ticks.set(wf, list);
    list.push({ ...r, wf, idx: list.length });
    this.snap();
  };

  /** Snapshot the world now (one per instant: a later snapshot at the same time replaces it). */
  snap() {
    const s = structuredClone(this.snapshot());
    const last = this.snapshots.at(-1);
    if (last && last.at === this.sim.now) last.s = s;
    else this.snapshots.push({ at: this.sim.now, s });
  }

  /** Wrap a workflow so its runs (and a termination) are recorded. */
  tracked<I>(fn: (rt: any, input: I) => Promise<{ status: string }>) {
    return async (rt: any, input: I) => {
      const list = this.runs.get(rt.workflowId) ?? [];
      this.runs.set(rt.workflowId, list);
      const run: WorkflowRun = { start: this.sim.now };
      list.push(run);
      try {
        const out = await fn(rt, input);
        Object.assign(run, { end: this.sim.now, outcome: out.status });
        return out;
      } catch (e) {
        Object.assign(run, { end: this.sim.now, outcome: e instanceof Terminated ? 'terminated' : 'failed' });
        throw e;
      }
    };
  }

  /** Run the simulation (optionally until a condition) and package the recording. */
  async finish(main: string, depthOf: (wf: string) => number, opts: { until?: () => boolean; maxMs?: number } = {}): Promise<TraceRun<S>> {
    let error: string | undefined;
    try { await this.sim.run(opts); } catch (e) { error = String(e); }
    this.snap();
    const lanes: Lane[] = [...this.runs.keys()]
      .map((wf) => ({ wf, depth: depthOf(wf), runs: this.runs.get(wf)!, ticks: this.ticks.get(wf) ?? [] }))
      .sort((a, b) => (a.wf === main ? -1 : b.wf === main ? 1 : a.runs[0]!.start - b.runs[0]!.start));
    const end = Math.max(this.sim.now, ...lanes.flatMap((l) => l.runs.map((r) => r.end ?? 0)));
    return { lanes, end, events: eventsFrom(lanes, end), snapshots: this.snapshots, result: this.sim.result(main), error };
  }
}

/** The event log: runs starting and ending, every action taken, early wake-ups, escalations. */
export function eventsFrom(lanes: Lane[], end: number, extra: LogEvent[] = []): LogEvent[] {
  const ev: LogEvent[] = [...extra];
  for (const l of lanes) {
    l.runs.forEach((r, i) => {
      ev.push({ at: r.start, wf: l.wf, kind: 'run', text: i ? 'run restarted (no memory)' : 'started' });
      if (r.end !== undefined && r.end <= end) ev.push({ at: r.end, wf: l.wf, kind: r.outcome === 'done' ? 'run' : 'outcome', text: `ended: ${r.outcome}` });
    });
    for (const t of l.ticks) {
      if (t.woke?.startsWith('signal:')) ev.push({ at: t.at, wf: l.wf, kind: 'signal', text: `woken by hint ${t.woke.slice(7)}` });
      for (const k of t.acted) ev.push({ at: t.at, wf: l.wf, kind: k.startsWith('escalate:') ? 'outcome' : 'action', text: k.startsWith('escalate:') ? `escalated to a person: ${k}` : k });
      if (t.stalled.length) ev.push({ at: t.at, wf: l.wf, kind: 'outcome', text: `plan repeats itself on ${t.stalled.join(', ')}` });
    }
  }
  return ev.sort((a, b) => a.at - b.at);
}

/** The last snapshot at or before t. */
export function snapshotAt<S>(snaps: { at: number; s: S }[], t: number): S | undefined {
  let lo = 0, hi = snaps.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (snaps[mid]!.at <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? snaps[best]!.s : snaps[0]?.s;
}
