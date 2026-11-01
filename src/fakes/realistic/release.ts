/**
 * Code review + release pipeline for a large monorepo service:
 *
 *   upload ─▶ presubmit ─▶ code-owner review ─▶ submit queue ─▶ merged
 *     (flaky reruns,        (working hours,      (conflicts)       │
 *      real failures)        change requests)                      ▼
 *   deployed ◀─ wave 50% ◀─ wave 10% ◀─ canary 1% ◀─ qualification ◀─ daily release cut (weekdays 18:00)
 *              (waves pause on weekends; a release is sometimes rolled back for unrelated reasons,
 *               and its CLs wait for the next cut)
 *
 * Uploads are idempotent on the change id (Gerrit-style Change-Id), unlike tracker creates.
 */
import { HOUR, MIN } from '../../core/time.js';
import type { Sim } from '../../runtime/sim.js';
import { afterWeekdayTime, afterWorkingTime, nextReleaseCut } from './calendar.js';
import { TransientError } from './bug-tracker.js';
import type { Rng } from './rng.js';

export type ClState = 'presubmit' | 'review' | 'submit-queue' | 'merged' | 'qualifying' | 'rolling-out' | 'deployed' | 'abandoned';

export interface Phase { label: string; from: number; to?: number }

export interface Cl {
  id: string;
  changeId: string;
  parent: string;
  finding: string;
  /** What the patch actually changes: a defect id, or something that fixes nothing. */
  ref: string;
  author: 'agent' | 'human';
  createdAt: number;
  state: ClState;
  phases: Phase[];
  /** Share of production running this CL, over time. */
  coverage: { at: number; value: number }[];
  deployedAt?: number;
}

export interface PipelineStats {
  rpcErrors: number; presubmitFlakes: number; presubmitFailures: number; reviewRounds: number;
  qualificationFailures: number; releaseRollbacks: number;
}

const WAVES = [
  { coverage: 0.01, ms: 3 * HOUR, label: 'canary 1%' },
  { coverage: 0.1, ms: 6 * HOUR, label: 'wave 10%' },
  { coverage: 0.5, ms: 12 * HOUR, label: 'wave 50%' },
];

export class ReleasePipeline {
  readonly cls = new Map<string, Cl>();
  private seq = 601_200_000;
  private cutPending = false;

  constructor(private sim: Sim, private rng: Rng, private stats: PipelineStats, private rpcErrorRate = 0.01) {}

  // ── API ──

  async upload(req: { changeId: string; parent: string; finding: string; ref: string }): Promise<Cl> {
    await this.rpc('upload');
    return this.create({ ...req, author: 'agent' });
  }

  async list(parent: string): Promise<Cl[]> {
    await this.rpc('list');
    return [...this.cls.values()].filter((c) => c.parent === parent).map((c) => structuredClone(c));
  }

  /** Internal path (people using the UI, no RPC faults). Idempotent on changeId. */
  create(req: { changeId: string; parent: string; finding: string; ref: string; author: Cl['author'] }): Cl {
    const existing = [...this.cls.values()].find((c) => c.changeId === req.changeId);
    if (existing) return existing;
    const cl: Cl = { ...req, id: `cl/${++this.seq}`, createdAt: this.sim.now, state: 'presubmit', phases: [], coverage: [{ at: this.sim.now, value: 0 }] };
    this.cls.set(cl.id, cl);
    this.presubmit(cl);
    return cl;
  }

  coverageAt(cl: Cl, t: number) {
    let v = 0;
    for (const c of cl.coverage) if (c.at <= t) v = c.value;
    return v;
  }

  /** Last time any CL reached 100% at or before t. */
  lastLandingBefore(t: number) {
    let last = -Infinity;
    for (const c of this.cls.values()) if (c.deployedAt !== undefined && c.deployedAt <= t) last = Math.max(last, c.deployedAt);
    return last;
  }

  // ── lifecycle ──

  private presubmit(cl: Cl, rerun = false) {
    this.enter(cl, 'presubmit', rerun ? 'presubmit (rerun)' : 'presubmit');
    this.after(this.rng.lognormal(45 * MIN, 0.4), () => {
      if (this.rng.chance(0.06)) { this.stats.presubmitFlakes++; return this.presubmit(cl, true); }
      if (this.rng.chance(0.03)) {
        this.stats.presubmitFailures++;
        this.enter(cl, 'presubmit', 'presubmit failed');
        // An agent's CL is abandoned (its loop will try again); a human fixes theirs.
        if (cl.author === 'agent') return this.afterWork(2 * HOUR, () => this.enter(cl, 'abandoned', 'abandoned', true));
        return this.afterWork(this.rng.lognormal(2 * HOUR, 0.6), () => this.presubmit(cl, true));
      }
      this.review(cl);
    });
  }

  private review(cl: Cl) {
    this.enter(cl, 'review', 'code review');
    this.afterWork(this.rng.lognormal(2.5 * HOUR, 0.8), () => {
      if (this.rng.chance(0.15)) {
        this.stats.reviewRounds++;
        this.enter(cl, 'review', 'addressing comments');
        return this.after(this.rng.lognormal(40 * MIN, 0.5), () => this.review(cl));
      }
      this.enter(cl, 'submit-queue', 'submit queue');
      this.after(this.rng.lognormal(20 * MIN, 0.5) + (this.rng.chance(0.03) ? HOUR : 0), () => this.merge(cl));
    });
  }

  private merge(cl: Cl) {
    this.enter(cl, 'merged', 'waiting for release cut');
    if (this.cutPending) return;
    this.cutPending = true;
    this.sim.at(nextReleaseCut(this.sim.now), () => this.cut());
  }

  private cut() {
    this.cutPending = false;
    const cls = [...this.cls.values()].filter((c) => c.state === 'merged');
    if (!cls.length) return;
    cls.forEach((c) => this.enter(c, 'qualifying', 'release qualification'));
    this.after(this.rng.lognormal(3 * HOUR, 0.3), () => {
      if (this.rng.chance(0.05)) { this.stats.qualificationFailures++; return cls.forEach((c) => this.merge(c)); }
      this.wave(cls, 0);
    });
  }

  private wave(cls: Cl[], i: number) {
    if (i === WAVES.length) {
      for (const c of cls) { this.setCoverage(c, 1); this.enter(c, 'deployed', 'deployed', true); c.deployedAt = this.sim.now; }
      return;
    }
    const w = WAVES[i]!;
    for (const c of cls) { this.setCoverage(c, w.coverage); this.enter(c, 'rolling-out', w.label); }
    this.sim.at(afterWeekdayTime(this.sim.now, w.ms), () => {
      if (this.rng.chance(0.03)) {
        this.stats.releaseRollbacks++;
        for (const c of cls) { this.setCoverage(c, 0); this.enter(c, 'merged', 'release rolled back'); }
        // The rolled-back CLs ride the next cut.
        return this.after(HOUR, () => cls.forEach((c) => this.merge(c)));
      }
      this.wave(cls, i + 1);
    });
  }

  // ── helpers ──

  private enter(cl: Cl, state: ClState, label: string, terminal = false) {
    const last = cl.phases.at(-1);
    if (last && last.to === undefined) last.to = this.sim.now;
    cl.state = state;
    cl.phases.push(terminal ? { label, from: this.sim.now, to: this.sim.now } : { label, from: this.sim.now });
  }
  private setCoverage(cl: Cl, value: number) { cl.coverage.push({ at: this.sim.now, value }); }
  private after(ms: number, fn: () => void) { this.sim.timer(ms, fn); }
  private afterWork(ms: number, fn: () => void) { this.sim.at(afterWorkingTime(this.sim.now, ms), fn); }

  private async rpc(method: string) {
    await this.sim.sleep(this.rng.lognormal(300, 0.6));
    if (this.rng.chance(this.rpcErrorRate)) {
      this.stats.rpcErrors++;
      throw new TransientError(`UNAVAILABLE: review.${method}`);
    }
  }
}
