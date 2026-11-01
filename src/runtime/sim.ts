/**
 * Deterministic, virtual-time durable-execution simulator for tests.
 * Weeks of wall-clock run in milliseconds. Supports child workflows, hint
 * signals, termination (to simulate losing a workflow entirely), and
 * scheduled world events.
 */
import { Terminated, type Runtime, type WakeReason } from '../core/runtime.js';

type Status = 'running' | 'completed' | 'failed' | 'terminated';
type WorkflowFn = (rt: SimRuntime, input: any) => Promise<unknown>;

interface Timer { at: number; seq: number; fire: () => void; cancelled: boolean }
interface Waiter { signals?: string[]; resolve: (r: WakeReason) => void; reject: (e: unknown) => void; timer: Timer }
interface WfRecord {
  id: string; name: string; status: Status; runs: number; startedAt: number;
  pending: Set<string>; waiter?: Waiter; done: Promise<unknown>; result?: unknown; error?: unknown;
}

/** Activity retry policy, as in Temporal: exponential backoff, then the error reaches the workflow. */
export interface RetryPolicy { maxAttempts: number; initialIntervalMs: number; backoff: number; maxIntervalMs: number }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 10, initialIntervalMs: 1_000, backoff: 2, maxIntervalMs: 100_000 };

import { DAY, HOUR, MIN } from '../core/time.js';
export { DAY, HOUR, MIN };

export class Sim {
  now: number;
  private seq = 0;
  private timers: Timer[] = [];
  private wfs = new Map<string, WfRecord>();
  private registry = new Map<string, WorkflowFn>();
  readonly events: { at: number; wf: string; msg: string }[] = [];

  constructor(start = 0) { this.now = start; }

  // ── time ──
  timer(delayMs: number, fire: () => void): Timer {
    const t: Timer = { at: this.now + Math.max(0, delayMs), seq: this.seq++, fire, cancelled: false };
    this.timers.push(t);
    return t;
  }
  sleep(ms: number) { return new Promise<void>((r) => this.timer(ms, r)); }
  /** Schedule a world event (a human comment, a metric regression, …). */
  at(atMs: number, fn: () => void) { this.timer(atMs - this.now, fn); }

  // ── workflows ──
  register(name: string, fn: WorkflowFn) { this.registry.set(name, fn); }

  start(workflowId: string, workflow: string, input: unknown): 'started' | 'exists' {
    const prev = this.wfs.get(workflowId);
    if (prev?.status === 'running') return 'exists';
    const fn = this.registry.get(workflow);
    if (!fn) throw new Error(`unknown workflow ${workflow}`);
    const rec: WfRecord = {
      id: workflowId, name: workflow, status: 'running', runs: (prev?.runs ?? 0) + 1, startedAt: this.now,
      pending: new Set(), done: undefined as any,
    };
    this.wfs.set(workflowId, rec);
    const rt = new SimRuntime(this, rec);
    rec.done = Promise.resolve()
      .then(() => fn(rt, input))
      .then(
        (r) => { if (rec.status === 'running') { rec.status = 'completed'; rec.result = r; } return r; },
        (e) => { if (rec.status === 'running') { rec.status = 'failed'; rec.error = e; } return undefined; },
      );
    this.log(workflowId, `started (${workflow}) run #${rec.runs}`);
    return 'started';
  }

  status(workflowId: string): Status | 'unknown' { return this.wfs.get(workflowId)?.status ?? 'unknown'; }
  result<T = unknown>(workflowId: string): T { return this.wfs.get(workflowId)?.result as T; }
  error(workflowId: string): unknown { return this.wfs.get(workflowId)?.error; }
  runs(workflowId: string) { return this.wfs.get(workflowId)?.runs ?? 0; }
  /** When the current (latest) run of a workflow started. */
  startedAt(workflowId: string) { return this.wfs.get(workflowId)?.startedAt; }

  signal(workflowId: string, name: string) {
    const rec = this.wfs.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    const w = rec.waiter;
    if (w && (!w.signals || w.signals.includes(name))) {
      w.timer.cancelled = true;
      rec.waiter = undefined;
      w.resolve({ reason: 'signal', name });
    } else rec.pending.add(name);
  }

  /** Kill a workflow outright: its memory is gone. Effects already made remain in the world. */
  terminate(workflowId: string) {
    const rec = this.wfs.get(workflowId);
    if (!rec || rec.status !== 'running') return;
    rec.status = 'terminated';
    this.log(workflowId, 'TERMINATED');
    const w = rec.waiter;
    if (w) { w.timer.cancelled = true; rec.waiter = undefined; w.reject(new Terminated(workflowId)); }
  }

  log(wf: string, msg: string) { this.events.push({ at: this.now, wf, msg }); }

  /** Advance virtual time until all workflows finish (or `until` holds). */
  async run(opts: { until?: () => boolean; maxMs?: number } = {}) {
    const limit = this.now + (opts.maxMs ?? 365 * DAY);
    for (;;) {
      await flush();
      if (opts.until?.()) return;
      const running = [...this.wfs.values()].filter((w) => w.status === 'running');
      this.timers = this.timers.filter((t) => !t.cancelled).sort((a, b) => a.at - b.at || a.seq - b.seq);
      // Done when nothing is running and no world events remain (a pending event may restart a workflow).
      if (!opts.until && running.length === 0 && this.timers.length === 0) return;
      const next = this.timers[0];
      if (!next) {
        if (running.length) throw new Error(`deadlock: ${running.map((r) => r.id).join(', ')} waiting with no timers`);
        return;
      }
      if (next.at > limit) throw new Error(`sim exceeded time limit at ${fmt(this.now)}`);
      this.now = next.at;
      while (this.timers[0] && this.timers[0].at === this.now) {
        const t = this.timers.shift()!;
        if (!t.cancelled) t.fire();
      }
    }
  }
}

export class SimRuntime implements Runtime {
  constructor(private sim: Sim, private rec: WfRecord) {}
  get workflowId() { return this.rec.id; }

  private check() { if (this.rec.status === 'terminated') throw new Terminated(this.rec.id); }

  now() { this.check(); return this.sim.now; }

  wait({ timeoutMs, signals }: { timeoutMs: number; signals?: string[] }): Promise<WakeReason> {
    this.check();
    const hit = [...this.rec.pending].find((s) => !signals || signals.includes(s));
    if (hit) { this.rec.pending.clear(); return Promise.resolve({ reason: 'signal', name: hit }); }
    return new Promise((resolve, reject) => {
      const timer = this.sim.timer(timeoutMs, () => { this.rec.waiter = undefined; resolve({ reason: 'timeout' }); });
      this.rec.waiter = { signals, resolve, reject, timer };
    });
  }

  async startChild(req: { workflowId: string; workflow: string; input: unknown }) {
    this.check();
    return this.sim.start(req.workflowId, req.workflow, req.input);
  }

  async hint(workflowId: string, signal: string) { this.check(); this.sim.signal(workflowId, signal); }

  /**
   * Sim-only: wrap activity implementations so a terminated workflow can't run more of them.
   * With `retry`, a failed call is retried with backoff (in virtual time) like a Temporal
   * activity; the error reaches the workflow only once attempts run out.
   */
  activities<T extends object>(impl: T, retry?: RetryPolicy): T {
    return new Proxy(impl, {
      get: (target, prop) => {
        const v = (target as any)[prop];
        if (typeof v !== 'function') return v;
        return async (...args: unknown[]) => {
          for (let attempt = 1; ; attempt++) {
            this.check();
            try {
              const r = await v.apply(target, args);
              this.check(); // worker died after the effect but before the workflow saw the result
              return r;
            } catch (e) {
              if (e instanceof Terminated || !retry || attempt >= retry.maxAttempts) throw e;
              await this.sim.sleep(Math.min(retry.maxIntervalMs, retry.initialIntervalMs * retry.backoff ** (attempt - 1)));
            }
          }
        };
      },
    });
  }
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

export const fmt = (ms: number) => {
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN);
  return `d${d}+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
