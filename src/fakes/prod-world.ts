/**
 * Fake production world for the experiment + investigation loops:
 * experiment config service, guardrail metrics, bug tracker, deploy system.
 * Planted "defects" drive the metrics; fixes that reach prod cure them.
 */
import { DAY, HOUR, type Sim } from '../runtime/sim.js';
import type { ExperimentActivities, ExperimentConfig, ExperimentState, GuardrailReading, Stage, Triage } from '../scenarios/experiment.js';
import type { InvestigationActivities } from '../scenarios/investigation.js';
import type { BugView, FixView, PageView } from '../scenarios/systems.js';

export interface Defect {
  id: string;
  signature: string;
  /**
   * Guardrail it breaks once triggered; omit for a latent dependency only found by RCA.
   * ProdWorld knows latency_p99, error_rate and revenue_per_user; RealisticWorld adds more.
   */
  guardrail?: string;
  severity?: 'mild' | 'severe';
  /** RealisticWorld only: true harm in relative % (default: a multiple of the threshold by severity). */
  effectPct?: number;
  triggerStage?: number;
  route: Triage['route'];
  analysisHours?: number;
  /** Defect id that must be fixed before this one can be (drives recursion). */
  requires?: string;
  /** Fixes reach prod but don't help (thrash → stuck). */
  unfixable?: boolean;
  /** ProdWorld only: the first N analyses blame the wrong cause, so their fixes don't help. */
  rcaWrongTimes?: number;
  /** Harm shows only after this long at or above the trigger stage (a novelty effect wearing off). */
  onsetMs?: number;
  /** ProdWorld only: the treatment arm this defect is in, in a multi-arm experiment. */
  arm?: string;
  /** Other guardrails the same cause moves (correlated metrics), optionally only after a delay. */
  alsoMoves?: { guardrail: string; afterMs?: number }[];
}

interface CL { id: string; key: string; parent: string; finding: string; ref: string; submittedAt: number }
interface Exp extends ExperimentState { keys: Set<string>; history: { at: number; stage: number; key: string; arm?: string }[]; escalations: string[] }

const GUARDRAILS = {
  latency_p99: { threshold: 300, good: 240, bad: 420 },
  error_rate: { threshold: 0.01, good: 0.004, bad: 0.03 },
  revenue_per_user: { threshold: -0.5, good: 0.1, bad: -2.1 },
  cpu_per_query: { threshold: 2, good: 0.4, bad: 6.5 },
} as const;

export class ProdWorld {
  readonly bugs = new Map<string, BugView>();
  readonly cls = new Map<string, CL>();
  readonly exps = new Map<string, Exp>();
  readonly defects = new Map<string, Defect & { triggeredAt?: number }>();
  readonly pages = new Map<string, PageView>();
  readonly calls: Record<string, number> = {};
  hooks: { onBugFiled?: (b: BugView) => void } = {};
  deployLatencyMs = 8 * HOUR;
  detectionLagMs = 2 * HOUR;
  metricsWindowMs = 6 * HOUR;
  /** How long on-call takes to pick up a page. */
  pageResponseMs = 4 * HOUR;
  private seq = { bug: 0, cl: 0, page: 0 };

  constructor(private sim: Sim) {}

/** An experiment someone already set up on a flag; the loop mounts it. */
  addExperiment(id: string, stages: Stage[], o: { flagName?: string; launchBug?: number; arms?: string[] } = {}) {
    const now = this.sim.now;
    this.exps.set(id, {
      id, flagName: o.flagName ?? FLAG, launchBug: o.launchBug ?? LAUNCH_BUG, stages, stage: 0, stageEnteredAt: now, status: 'running',
      peakStage: 0,
      arms: o.arms?.map((name) => ({ name, stage: 0, stageEnteredAt: now, peakStage: 0 })),
      keys: new Set(), history: o.arms ? o.arms.map((arm) => ({ at: now, stage: 0, key: 'init', arm })) : [{ at: now, stage: 0, key: 'init' }], escalations: [],
    });
  }
  private byFlag(flagName: string) { return [...this.exps.values()].filter((e) => e.flagName === flagName); }
  addDefect(d: Defect) { this.defects.set(d.id, { ...d }); }

  // ── derived state ──
  private inProdAt(cl: CL) { return cl.submittedAt + this.deployLatencyMs; }
  private live(cl: CL) { return this.sim.now >= this.inProdAt(cl); }
  isFixed(defectId: string) {
    const d = this.defects.get(defectId)!;
    return !d.unfixable && [...this.cls.values()].some((c) => c.ref === defectId && this.live(c));
  }
  private bySignature(sig: string) { return [...this.defects.values()].find((d) => d.signature === sig)!; }

  readings(expId: string): GuardrailReading[] {
    const exp = this.exps.get(expId)!;
    if (exp.arms) return exp.arms.flatMap((a) => this.armReadings(a.stageEnteredAt, a.name));
    return this.armReadings(exp.stageEnteredAt);
  }
  /** One set of guardrail readings: for the whole treatment, or for one arm against control. */
  private armReadings(stageEnteredAt: number, arm?: string): GuardrailReading[] {
    const lastLanding = Math.max(0, ...[...this.cls.values()].filter((c) => this.live(c)).map((c) => this.inProdAt(c)));
    const lastChange = Math.max(stageEnteredAt, lastLanding);
    return (Object.keys(GUARDRAILS) as (keyof typeof GUARDRAILS)[]).map((g) => {
      const spec = GUARDRAILS[g];
      // A defect moves its own guardrail, and any it is correlated with (some only after a delay).
      const delay = (d: Defect) => (d.guardrail === g ? 0 : d.alsoMoves?.find((m) => m.guardrail === g) ? d.alsoMoves.find((m) => m.guardrail === g)!.afterMs ?? 0 : undefined);
      const active = [...this.defects.values()].find((d) => {
        const extra = delay(d);
        return extra !== undefined && d.arm === arm && d.triggeredAt !== undefined && this.sim.now - d.triggeredAt >= this.detectionLagMs + (d.onsetMs ?? 0) + extra && !this.isFixed(d.id);
      });
      if (active) return { guardrail: g, verdict: 'fail', value: spec.bad, threshold: spec.threshold, severity: active.severity ?? 'mild', signature: active.signature, arm };
      const verdict = this.sim.now - lastChange < this.metricsWindowMs ? 'insufficient' : 'pass';
      return { guardrail: g, verdict, value: spec.good, threshold: spec.threshold, severity: 'mild', arm };
    });
  }

  // ── test helpers: humans acting out-of-band ──
  humanShipsFix(defectId: string, key = `human/${defectId}`) {
    this.cls.set(`cl/${++this.seq.cl}`, { id: `cl/${this.seq.cl}`, key, parent: 'human', finding: '-', ref: defectId, submittedAt: this.sim.now });
  }
  humanClosesBug(bugId: string, resolution: 'fixed' | 'wontfix' = 'fixed') {
    const b = this.bugs.get(bugId)!;
    Object.assign(b, { status: resolution, closedAt: this.sim.now });
    b.notes.push(`closed ${resolution} by human`);
  }
  /** A person hands an escalated bug back to its investigation without closing it. */
  humanHandsBack(bugId: string) {
    const b = this.bugs.get(bugId)!;
    b.withPerson = undefined;
    b.notes.push('handed back by human');
  }
  /** On-call answers a page: ships the real fix for whatever is breaking that guardrail, resolves once it's live. */
  private onCall(p: PageView) {
    this.sim.timer(this.pageResponseMs, () => {
      // The page is about a regression (maybe one arm's): fix whatever triggered defect is behind it.
      const parts = p.finding.split(':');
      const arm = parts.length === 3 ? parts[1] : undefined;
      const d = [...this.defects.values()].find((x) => x.guardrail && x.arm === arm && x.triggeredAt !== undefined && !this.isFixed(x.id));
      const resolve = (resolution: string) => Object.assign(p, { status: 'resolved', resolvedAt: this.sim.now, resolution });
      if (!d) return resolve('nothing wrong found; resuming');
      this.humanShipsFix(d.id, `oncall/${p.id}`);
      this.sim.timer(this.deployLatencyMs, () => resolve(`shipped a fix for ${d.signature}`));
    });
  }
  stageAt(expId: string, t: number) {
    const h = this.exps.get(expId)!.history.filter((x) => x.at <= t);
    return h[h.length - 1]!.stage;
  }

  // ── activities (one object implements both interfaces) ──
  activities(): ExperimentActivities & InvestigationActivities {
    const w = this;
    const clone = <T>(v: T): T => structuredClone(v);
    const count = (n: string) => { w.calls[n] = (w.calls[n] ?? 0) + 1; };
    const fixView = (c: CL): FixView => ({ clId: c.id, key: c.key, parent: c.parent, finding: c.finding, ref: c.ref, state: w.live(c) ? 'in-prod' : 'submitted' });
    return {
      async findExperimentsByFlag(flag) { count('findExperimentsByFlag'); return w.byFlag(flag).filter((e) => e.status === 'running').map(({ keys, history, escalations, ...e }) => clone(e)); },
      async draftExperiment(flag) { count('draftExperiment'); return draftConfig(flag); },
      async createExperiment(config) {
        count('createExperiment');
        const same = w.byFlag(config.flagName).find((e) => e.launchBug === config.launchBug && e.status === 'running');
        if (!same) {
          w.addExperiment(`E${w.exps.size + 1}`, RAMP_POLICIES[config.rampPolicy]!, config);
          w.sim.log('experiments', `created E${w.exps.size} on ${config.flagName}`);
        }
        const { keys, history, escalations, ...e } = same ?? [...w.exps.values()].at(-1)!;
        return clone(e);
      },
      async getExperiment(id) { count('getExperiment'); const { keys, history, escalations, ...e } = w.exps.get(id)!; return clone(e); },
      async readGuardrails(id) { count('readGuardrails'); return w.readings(id); },
      async triage(_id, failing, ep) {
        count('triage');
        // Debug the whole regression at once: the worst metric's cause first.
        const r = [...failing].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'severe' ? -1 : 1))[0]!;
        const d = w.bySignature(r.signature!);
        const metrics = failing.map((x) => x.guardrail).join(', ');
        if (d.route === 'quick-fix') return { route: 'quick-fix', patch: { summary: `fix ${d.id} (ep ${ep})`, ref: d.id } };
        if (d.route === 'investigate') return { route: 'investigate', title: `[${metrics}] ${d.signature}`, hypothesis: 'needs RCA', signature: d.signature };
        return { route: 'escalate', reason: `playbook has no automated response for ${d.signature}` };
      },
      async setStage(id, stage, key, arm) {
        count('setStage');
        const e = w.exps.get(id)!;
        if (e.keys.has(key)) return;
        e.keys.add(key);
        const target = arm ? e.arms!.find((a) => a.name === arm)! : e;
        Object.assign(target, { stage, stageEnteredAt: w.sim.now, peakStage: Math.max(target.peakStage, stage) });
        e.history.push({ at: w.sim.now, stage, key, arm });
        for (const d of w.defects.values())
          if (d.arm === arm && d.triggerStage !== undefined && stage >= d.triggerStage && d.triggeredAt === undefined) d.triggeredAt = w.sim.now;
      },
      async conclude(id) { count('conclude'); w.exps.get(id)!.status = 'complete'; },
      async escalate(flag, reason) { count('escalate'); for (const e of w.byFlag(flag)) e.escalations.push(reason); },
      async page(req) {
        count('page');
        const existing = [...w.pages.values()].find((p) => p.key === req.key);
        if (existing) return existing.id;
        const p: PageView = { id: `P-${++w.seq.page}`, ...req, status: 'open', openedAt: w.sim.now };
        w.pages.set(p.id, p);
        w.sim.log('pager', `paged on-call (${p.id}): ${p.reason}`);
        w.onCall(p);
        return p.id;
      },
      async listPages(parent) { count('listPages'); return structuredClone([...w.pages.values()].filter((p) => p.parent === parent)); },

      async listChildBugs(parent) { count('listChildBugs'); return clone([...w.bugs.values()].filter((b) => b.parent === parent)); },
      async listFixes(parent) { count('listFixes'); return [...w.cls.values()].filter((c) => c.parent === parent).map(fixView); },
      async workflowStatus(id) { count('workflowStatus'); return w.sim.status(id); },
      async fileBug(req) {
        count('fileBug');
        const existing = [...w.bugs.values()].find((b) => b.key === req.key);
        if (existing) return existing.id;
        const b: BugView = { id: `B-${++w.seq.bug}`, ...req, status: 'open', createdAt: w.sim.now, notes: [] };
        w.bugs.set(b.id, b);
        w.sim.log('bugs', `filed ${b.id} (${b.title}) parent=${b.parent}`);
        w.hooks.onBugFiled?.(b);
        return b.id;
      },
      async submitFix(req) {
        count('submitFix');
        const existing = [...w.cls.values()].find((c) => c.key === req.key);
        if (existing) return existing.id;
        const c: CL = { id: `cl/${++w.seq.cl}`, key: req.key, parent: req.parent, finding: req.finding, ref: req.patch.ref, submittedAt: w.sim.now };
        w.cls.set(c.id, c);
        w.sim.log('deploy', `submitted ${c.id} for ${req.parent}/${req.finding}`);
        return c.id;
      },

      async getBug(id) { count('getBug'); return clone(w.bugs.get(id)!); },
      async analyze(bugId, attempt) {
        count('analyze');
        const b = w.bugs.get(bugId)!;
        const d = w.bySignature(b.signature);
        await w.sim.sleep((d.analysisHours ?? 12) * HOUR);
        if (attempt < (d.rcaWrongTimes ?? 0)) {
          b.rootCause = { summary: `misattributed (analysis ${attempt + 1})`, fix: { summary: 'unrelated patch', ref: `wrong:${d.id}:${attempt}` } };
          return;
        }
        const req = d.requires ? w.defects.get(d.requires)! : undefined;
        b.rootCause = {
          summary: `root cause of ${d.id}`,
          fix: { summary: `patch ${d.id}`, ref: d.id },
          requires: req && { title: `prerequisite: ${req.signature}`, signature: req.signature },
        };
      },
      async verifyFix(bugId) {
        count('verifyFix');
        const d = w.bySignature(w.bugs.get(bugId)!.signature);
        return w.isFixed(d.id)
          ? { verdict: 'cured', detail: `${d.signature} no longer reproduces` }
          : { verdict: 'reproduces', detail: `${d.signature} still reproduces with the fix live` };
      },
      async closeBug(id, resolution, note) {
        count('closeBug');
        const b = w.bugs.get(id)!;
        if (b.status !== 'open') return;
        Object.assign(b, { status: resolution, closedAt: w.sim.now });
        b.notes.push(note);
        w.sim.log('bugs', `closed ${id} ${resolution}`);
      },
      async annotateBug(id, note) { count('annotateBug'); w.bugs.get(id)!.notes.push(note); },
      async escalateBug({ bugId, key, finding, reason }) {
        count('escalateBug');
        const b = w.bugs.get(bugId)!;
        if (b.notes.some((n) => n.includes(key))) return;
        b.withPerson = { finding, since: w.sim.now };
        b.notes.push(`needs a person: ${reason} [${key}]`);
        w.sim.log('bugs', `escalated ${bugId} to a person: ${reason}`);
      },
    };
  }
}

export const STANDARD_RAMP: Stage[] = [
  { percent: 1, soakMs: 1 * DAY },
  { percent: 5, soakMs: 2 * DAY },
  { percent: 25, soakMs: 2 * DAY },
  { percent: 50, soakMs: 3 * DAY },
  { percent: 100, soakMs: 3 * DAY },
];

/** Ramp policies as the experiment service defines them: a policy name sets the stages. */
export const RAMP_POLICIES: Record<string, Stage[]> = {
  /** Low-risk changes: four quick stages. */
  fast: [
    { percent: 1, soakMs: 12 * HOUR },
    { percent: 10, soakMs: 1 * DAY },
    { percent: 50, soakMs: 1 * DAY },
    { percent: 100, soakMs: 1 * DAY },
  ],
  standard: STANDARD_RAMP,
  /** Risky changes: start smaller, soak longer. */
  cautious: [
    { percent: 0.5, soakMs: 2 * DAY },
    { percent: 1, soakMs: 2 * DAY },
    { percent: 5, soakMs: 3 * DAY },
    { percent: 25, soakMs: 3 * DAY },
    { percent: 50, soakMs: 4 * DAY },
    { percent: 100, soakMs: 4 * DAY },
  ],
  /** Launch to 99% and keep a 1% holdback for four weeks, to catch long-term effects. */
  holdback: [
    { percent: 1, soakMs: 1 * DAY },
    { percent: 5, soakMs: 2 * DAY },
    { percent: 25, soakMs: 2 * DAY },
    { percent: 50, soakMs: 3 * DAY },
    { percent: 99, soakMs: 28 * DAY },
  ],
};

export const RAMP_POLICY_NAMES = Object.keys(RAMP_POLICIES);

/** The flag every scenario ramps, and the launch bug of the experiment already on it. */
export const FLAG = 'checkout_v2';
export const LAUNCH_BUG = 1001;

/** What the drafting agent suggests for a new experiment on a flag. */
export function draftConfig(flagName: string): ExperimentConfig {
  return {
    flagName, featureName: flagName.replace(/_/g, ' '), launchLayer: 'web_checkout', launchBug: LAUNCH_BUG,
    rampPolicy: 'standard', expectedLaunchDate: '2026-12-01', owners: ['checkout-team'],
  };
}
