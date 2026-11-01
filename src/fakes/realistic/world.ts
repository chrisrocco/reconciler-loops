/**
 * A realistic production world for the experiment + investigation loops, modeled on how
 * a large engineering org runs experiments, tracks bugs and ships fixes.
 *
 * Ground truth (planted defects, how much harm each does at each traffic share, how much
 * of each fix has rolled out) lives here and is invisible to the loops. They only see it
 * through the same kind of systems production has, each with its usual imperfections:
 *
 *   experiment config   stage changes take minutes to propagate to serving; in a multi-arm
 *                       experiment each treatment arm has its own stage, traffic and readout
 *   metrics             noisy CIs, late data, stalls, false positives      (metrics.ts)
 *   issue tracker       rich statuses, lagging search, non-idempotent create (bug-tracker.ts)
 *   review + release    presubmit, human review, daily cut, weekday rollout (release.ts)
 *   workflow engine     describe() lags a fresh start; RPCs fail transiently
 *   agents              triage misroutes; RCA is slow, sometimes inconclusive or wrong
 *   people              triager marks duplicates; on-call handles escalations in working hours
 *
 * `activities()` is the adapter layer: it maps these systems onto the framework's
 * activity interfaces, the way a production integration would. Run it under the sim's
 * activity retry policy (DEFAULT_RETRY), since every RPC can fail.
 */
import { HOUR, MIN } from '../../core/time.js';
import type { Sim } from '../../runtime/sim.js';
import type { ExperimentActivities, ExperimentState, GuardrailReading, Stage, Triage } from '../../scenarios/experiment.js';
import type { InvestigationActivities } from '../../scenarios/investigation.js';
import type { Verification } from '../../scenarios/investigation.js';
import type { BugView, PageView, RootCause } from '../../scenarios/systems.js';
import { draftConfig, FLAG, LAUNCH_BUG, RAMP_POLICIES, type Defect } from '../prod-world.js';
import { BugTracker, FIXED, OPEN, TransientError, type Issue } from './bug-tracker.js';
import { afterWorkingTime } from './calendar.js';
import { GUARDRAILS, MetricsPipeline, type Treatment } from './metrics.js';
import { ReleasePipeline, type Cl } from './release.js';
import { Rng, rngFor } from './rng.js';

/** A stage change: for the whole treatment, or for one arm in a multi-arm experiment. */
interface StageChange { at: number; effectiveAt: number; stage: number; key: string; arm?: string }
interface Exp extends ExperimentState { keys: Set<string>; history: StageChange[]; escalations: string[] }

/** Counts of the imperfections that actually occurred in a run. */
export interface WorldStats {
  rpcErrors: number; ambiguousCreates: number; statusLag: number; staleReadouts: number;
  falseAlarms: number; misroutes: number; rcaInconclusive: number; rcaWrong: number; rcaMissedPrereq: number;
  /** Verification found a live fix had not cured the symptom. */
  fixesIneffective: number;
  /** Verification gave the wrong verdict (flaky repro, noisy signal). */
  verifyWrong: number;
  duplicateBugs: number; humanInterventions: number; humanFixes: number; pages: number;
  presubmitFlakes: number; presubmitFailures: number; reviewRounds: number; qualificationFailures: number; releaseRollbacks: number;
}

/** A live fix must have soaked this long before verification can tell (late data, low traffic paths). */
const VERIFY_SOAK = 6 * HOUR;
/** How long on-call keeps at a fix that is live but not working before giving up on it. */
const ON_CALL_PATIENCE = 7 * 24 * HOUR;

const ROUTES: Triage['route'][] = ['quick-fix', 'investigate', 'escalate'];

/** The arm a finding is about, for a per-arm regression (`regression:<arm>:s<stage>`). */
const armOf = (finding: string) => { const p = finding.split(':'); return p[0] === 'regression' && p.length === 3 ? p[1] : undefined; };

export class RealisticWorld {
  readonly tracker: BugTracker;
  readonly pipeline: ReleasePipeline;
  readonly metrics: MetricsPipeline;
  readonly exps = new Map<string, Exp>();
  readonly defects = new Map<string, Defect>();
  readonly stats: WorldStats = {
    rpcErrors: 0, ambiguousCreates: 0, statusLag: 0, staleReadouts: 0,
    falseAlarms: 0, misroutes: 0, rcaInconclusive: 0, rcaWrong: 0, rcaMissedPrereq: 0, fixesIneffective: 0, verifyWrong: 0,
    duplicateBugs: 0, humanInterventions: 0, humanFixes: 0, pages: 0,
    presubmitFlakes: 0, presubmitFailures: 0, reviewRounds: 0, qualificationFailures: 0, releaseRollbacks: 0,
  };
  readonly pages = new Map<string, PageView>();
  hooks: { onBugFiled?: (b: BugView) => void } = {};

  private agents: Rng;
  private people: Rng;
  private infra: Rng;
  private verifier: Rng;
  private onCallFor = new Set<string>();
  private humanCls = 0;

  constructor(readonly sim: Sim, readonly seed: number) {
    // Separate streams, so e.g. a change to the release model doesn't reshuffle agent behavior.
    this.agents = rngFor(seed, 'agents');
    this.people = rngFor(seed, 'people');
    this.infra = rngFor(seed, 'infra');
    this.verifier = rngFor(seed, 'verify');
    this.tracker = new BugTracker(sim, rngFor(seed, 'tracker'), this.stats);
    this.pipeline = new ReleasePipeline(sim, rngFor(seed, 'pipeline'), this.stats);
    this.metrics = new MetricsPipeline(seed);
    this.tracker.onCreate = (i) => this.onIssueCreated(i);
  }

/** An experiment someone already set up on a flag; the loop mounts it. */
  addExperiment(id: string, stages: Stage[], o: { flagName?: string; launchBug?: number; arms?: string[] } = {}) {
    const now = this.sim.now;
    this.exps.set(id, {
      id, flagName: o.flagName ?? FLAG, launchBug: o.launchBug ?? LAUNCH_BUG, stages, stage: 0, stageEnteredAt: now, status: 'running', peakStage: 0,
      arms: o.arms?.map((name) => ({ name, stage: 0, stageEnteredAt: now, peakStage: 0 })),
      keys: new Set(), escalations: [],
      history: (o.arms ?? [undefined]).map((arm) => ({ at: now, effectiveAt: now, stage: 0, key: 'init', arm })),
    });
  }
  /** The experiment a loop labeled `exp:<flag>` manages (the running one on that flag). */
  expFor(parent: string) {
    const flag = parent.replace(/^exp:/, '');
    const on = [...this.exps.values()].filter((e) => e.flagName === flag);
    return on.find((e) => e.status === 'running') ?? on.at(-1);
  }
  addDefect(d: Defect) { this.defects.set(d.id, { ...d }); }

  // ───────────────────────────── ground truth ─────────────────────────────

  /** The stage actually serving at t, for the treatment or one arm (config pushes take minutes to land). */
  servingStage(exp: Exp, t: number, arm?: string) {
    let s = 0;
    for (const h of exp.history) if (h.arm === arm && h.effectiveAt <= t) s = h.stage;
    return s;
  }

  /** Share of the defect's harm removed at t: its fix's rollout coverage, gated on prerequisites. */
  cureFraction(d: Defect, t: number): number {
    if (d.unfixable) return 0;
    let cov = 0;
    for (const c of this.pipeline.cls.values()) if (c.ref === d.id) cov = Math.max(cov, this.pipeline.coverageAt(c, t));
    const req = d.requires ? this.defects.get(d.requires) : undefined;
    return req ? cov * this.cureFraction(req, t) : cov;
  }

  effectPct(d: Defect) {
    const g = GUARDRAILS.find((x) => x.name === d.guardrail);
    return d.effectPct ?? (d.severity === 'severe' ? 6 : 2.2) * (g?.thresholdPct ?? 1);
  }

  /**
   * True harm of one defect on guardrail `g` at t: its own guardrail, or one it is correlated with
   * (the same relative size against that guardrail's threshold, maybe after a delay).
   */
  harmOn(d: Defect, g: string, exp: Exp, t: number) {
    if (d.guardrail === g) return this.harmOf(d, exp, t);
    const m = d.alsoMoves?.find((x) => x.guardrail === g);
    if (!m || !d.guardrail) return 0;
    const h = this.harmOf(d, exp, t - (m.afterMs ?? 0)) && this.harmOf(d, exp, t);
    const thr = (name: string) => GUARDRAILS.find((x) => x.name === name)?.thresholdPct ?? 1;
    return (h / thr(d.guardrail)) * thr(g);
  }

  /** True harm of one defect on its guardrail at t, in its own arm. Load-dependent: none below its trigger stage. */
  harmOf(d: Defect, exp: Exp, t: number) {
    if (!d.guardrail) return 0;
    if (d.triggerStage !== undefined && this.servingStage(exp, t, d.arm) < d.triggerStage) return 0;
    if (d.onsetMs) {
      // A long-term effect: none until the treatment has been at the trigger stage this long.
      const exposedAt = exp.history.find((h) => h.arm === d.arm && h.effectiveAt <= t && h.stage >= (d.triggerStage ?? 0))?.effectiveAt;
      if (exposedAt === undefined || t - exposedAt < d.onsetMs) return 0;
    }
    return this.effectPct(d) * (1 - this.cureFraction(d, t));
  }

  /** The treatment as the analysis sees it: the whole treatment, or one arm against control. */
  treatment(exp: Exp, arm?: string): Treatment {
    const history = exp.history.filter((h) => h.arm === arm);
    return {
      trafficPct: (t) => exp.stages[this.servingStage(exp, t, arm)]!.percent,
      windowStart: (t) => {
        let ws = history[0]!.effectiveAt;
        for (const h of history) if (h.effectiveAt <= t) ws = h.effectiveAt;
        return Math.max(ws, this.pipeline.lastLandingBefore(t));
      },
      harm: (g, t) => {
        let sum = 0;
        for (const d of this.defects.values()) if (d.arm === arm) sum += this.harmOn(d, g, exp, t);
        return sum;
      },
    };
  }

  private activeDefects(exp: Exp, guardrail: string, t: number, arm?: string) {
    return [...this.defects.values()].filter((d) => d.arm === arm && this.harmOn(d, guardrail, exp, t) > 0);
  }

  /** What an issue is really about: matched by signature, or the defect behind the breach it was filed for. */
  private truthFor(i: Issue): string | undefined {
    const bySig = [...this.defects.values()].find((d) => d.signature === i.fields.signature);
    if (bySig) return bySig.id;
    // Filed for a regression: the defect doing the most harm right now in its arm, on any guardrail.
    const exp = i.fields.finding.startsWith('regression:') && i.fields.parent.startsWith('exp:') ? this.expFor(i.fields.parent) : undefined;
    if (!exp) return undefined;
    const arm = armOf(i.fields.finding);
    const harm = (d: Defect) => this.harmOf(d, exp, this.sim.now) / (GUARDRAILS.find((x) => x.name === d.guardrail)?.thresholdPct ?? 1);
    return [...this.defects.values()].filter((d) => d.arm === arm && harm(d) > 0).sort((a, b) => harm(b) - harm(a))[0]?.id;
  }

  // ───────────────────────────── people ─────────────────────────────

  private onIssueCreated(i: Issue) {
    i.truth = this.truthFor(i);
    if (i.reporter === 'agent') this.sim.at(afterWorkingTime(this.sim.now, this.people.lognormal(1.5 * HOUR, 0.8)), () => this.humanTriage(i.id));
    this.hooks.onBugFiled?.(this.view(i));
  }

  /** The component triager: dedupes against open issues for the same finding, else assigns on-call. */
  private humanTriage(id: string) {
    const i = this.tracker.issues.get(id)!;
    if (i.status !== 'NEW') return;
    const dup = [...this.tracker.issues.values()].find((o) =>
      o.id !== i.id && o.createdAt <= i.createdAt && OPEN.has(o.status) &&
      o.fields.parent === i.fields.parent && o.fields.finding === i.fields.finding);
    if (dup) {
      this.stats.duplicateBugs++;
      this.tracker.edit(id, 'triager', { status: 'DUPLICATE', duplicateOf: dup.id }, `Duplicate of ${dup.id}.`);
    } else {
      this.tracker.edit(id, 'triager', { status: 'ASSIGNED', assignee: 'experiments-oncall' }, 'Assigned to the experiments on-call.');
    }
  }

  /** An escalated investigation lands on the on-call's queue; they act in working hours. */
  private onCall(bugId: string) {
    if (this.onCallFor.has(bugId)) return;
    this.onCallFor.add(bugId);
    this.stats.humanInterventions++;
    this.sim.at(afterWorkingTime(this.sim.now, this.people.lognormal(4 * HOUR, 0.7)), () => {
      const i = this.tracker.canonical(bugId);
      if (!OPEN.has(i.status)) return;
      const truth = i.truth ? this.defects.get(i.truth) : undefined;
      if (!truth) {
        this.tracker.edit(i.id, 'oncall', { status: 'INTENDED_BEHAVIOR' }, 'Could not reproduce; this looks like metric noise. Closing.');
        return;
      }
      // Fix the real problem, prerequisites included, then close once it's verified in prod.
      const chain: Defect[] = [];
      for (let d: Defect | undefined = truth; d; d = d.requires ? this.defects.get(d.requires) : undefined)
        if (this.cureFraction(d, this.sim.now) < 1) chain.push(d);
      chain.forEach((d) => this.humanShipsFix(d.id));
      const giveUpAt = this.sim.now + ON_CALL_PATIENCE;
      const check = () => {
        if (this.cureFraction(truth, this.sim.now) >= 1) this.tracker.edit(i.id, 'oncall', { status: 'FIXED' }, 'Fix rolled out; metric recovered.');
        else if (this.sim.now >= giveUpAt) this.tracker.edit(i.id, 'oncall', { status: 'INFEASIBLE' }, 'Fixes are live but it still reproduces; needs a redesign. Closing.');
        else this.sim.timer(4 * HOUR, check);
      };
      this.sim.timer(4 * HOUR, check);
    });
  }

  /**
   * A page reaches the experiment's on-call at any hour; they ack within minutes, dig in for
   * a few hours, then either call it noise or ship the real fix (prerequisites included)
   * and resolve the page once the guardrail has recovered.
   */
  private answerPage(p: PageView) {
    this.stats.pages++;
    const exp = this.expFor(p.parent)!;
    const resolve = (resolution: string) => Object.assign(p, { status: 'resolved', resolvedAt: this.sim.now, resolution });
    this.sim.timer(this.people.lognormal(15 * MIN, 0.6) + this.people.lognormal(3 * HOUR, 0.6), () => {
      // They read the last day of dashboards, so a defect hidden since by the safety rollback still shows.
      const truth = [...this.defects.values()].find((d) => d.guardrail && d.arm === armOf(p.finding) && this.cureFraction(d, this.sim.now) < 1 &&
        Array.from({ length: 25 }, (_, h) => this.sim.now - h * HOUR).some((t) => t >= 0 && this.harmOf(d, exp, t) > 0));
      if (!truth) return resolve('looked into it: metric noise, nothing to fix; resuming');
      const chain: Defect[] = [];
      for (let d: Defect | undefined = truth; d; d = d.requires ? this.defects.get(d.requires) : undefined)
        if (this.cureFraction(d, this.sim.now) < 1) chain.push(d);
      chain.forEach((d) => this.humanShipsFix(d.id));
      const giveUpAt = this.sim.now + ON_CALL_PATIENCE;
      const check = () => {
        if (this.cureFraction(truth, this.sim.now) >= 1) resolve(`shipped a fix for ${truth.signature}; recovered`);
        else if (this.sim.now >= giveUpAt) resolve(`fixes for ${truth.signature} are live but it persists; handing back to the experiment owner`);
        else this.sim.timer(2 * HOUR, check);
      };
      this.sim.timer(2 * HOUR, check);
    });
  }

  humanShipsFix(defectId: string, key = `human/${defectId}/${++this.humanCls}`) {
    this.stats.humanFixes++;
    return this.pipeline.create({ changeId: key, parent: 'human', finding: '-', ref: defectId, author: 'human' });
  }

  humanClosesBug(bugId: string, resolution: 'fixed' | 'wontfix' = 'fixed') {
    this.tracker.edit(bugId, 'human', { status: resolution === 'fixed' ? 'FIXED' : 'WONTFIX' }, `closed ${resolution} by human`);
  }

  // ───────────────────────────── adapter ─────────────────────────────

  /** BugView from an issue: rich statuses collapse to open / fixed / wontfix, following DUPLICATE links. */
  view(i: Issue): BugView {
    const c = this.tracker.canonical(i.id);
    return {
      id: i.id, key: i.fields.key, title: i.title, parent: i.fields.parent, finding: i.fields.finding,
      signature: i.fields.signature, depth: i.fields.depth,
      status: OPEN.has(c.status) ? 'open' : FIXED.has(c.status) ? 'fixed' : 'wontfix',
      createdAt: i.createdAt, closedAt: c.closedAt, rootCause: i.rootCause, withPerson: i.withPerson,
      notes: i.comments.map((m) => `${m.author}: ${m.text}`),
    };
  }

  activities(): ExperimentActivities & InvestigationActivities {
    const w = this;
    const sim = this.sim;
    const exp = (id: string) => w.exps.get(id)!;
    const view = ({ keys, history, escalations, ...e }: Exp) => structuredClone(e);
    return {
      async findExperimentsByFlag(flag) {
        await w.rpc('experiments.search');
        return [...w.exps.values()].filter((e) => e.flagName === flag && e.status === 'running').map(view);
      },
      async draftExperiment(flag) { await sim.sleep(w.agents.lognormal(2 * MIN, 0.5)); return draftConfig(flag); },
      async createExperiment(config) {
        await w.rpc('experiments.create');
        // The experiment service refuses a second experiment on a flag with the same launch bug, and returns the first.
        const same = [...w.exps.values()].find((e) => e.flagName === config.flagName && e.launchBug === config.launchBug && e.status === 'running');
        if (same) return view(same);
        const id = `E${w.exps.size + 1}`;
        w.addExperiment(id, RAMP_POLICIES[config.rampPolicy]!, config);
        return view(exp(id));
      },
      async getExperiment(id) {
        await w.rpc('experiments.get');
        const { keys, history, escalations, ...e } = exp(id);
        return structuredClone(e);
      },
      async readGuardrails(id) {
        await w.rpc('analysis.readout');
        const e = exp(id);
        if (!e.arms) {
          const r = w.metrics.readout(w.treatment(e), sim.now);
          if (r.stale) w.stats.staleReadouts++;
          return r.readings;
        }
        // A multi-arm experiment reports each arm against control.
        const rs = e.arms.map((a) => ({ arm: a.name, r: w.metrics.readout(w.treatment(e, a.name), sim.now, a.name) }));
        if (rs[0]!.r.stale) w.stats.staleReadouts++;
        return rs.flatMap(({ arm, r }) => r.readings.map((x) => ({ ...x, arm })));
      },
      async triage(id, failing, episode) {
        await sim.sleep(w.agents.lognormal(4 * MIN, 0.5));
        return w.triage(exp(id), failing, episode);
      },
      async setStage(id, stage, key, arm) {
        await w.rpc('experiments.update');
        const e = exp(id);
        if (e.keys.has(key)) return;
        e.keys.add(key);
        const target = arm ? e.arms!.find((a) => a.name === arm)! : e;
        target.peakStage = Math.max(target.peakStage, stage);
        Object.assign(target, { stage, stageEnteredAt: sim.now });
        e.history.push({ at: sim.now, effectiveAt: sim.now + w.infra.lognormal(12 * MIN, 0.5), stage, key, arm });
      },
      async conclude(id) { await w.rpc('experiments.update'); exp(id).status = 'complete'; },
      async escalate(flag, reason) { await w.rpc('pager.page'); w.expFor(`exp:${flag}`)?.escalations.push(reason); },
      async page(req) {
        await w.rpc('pager.page');
        // The pager dedupes on its incident key, so a retried call doesn't page twice.
        const existing = [...w.pages.values()].find((p) => p.key === req.key);
        if (existing) return existing.id;
        const p: PageView = { id: `P-${w.pages.size + 1}`, ...req, status: 'open', openedAt: sim.now };
        w.pages.set(p.id, p);
        w.answerPage(p);
        return p.id;
      },
      async listPages(parent) {
        await w.rpc('pager.list');
        return structuredClone([...w.pages.values()].filter((p) => p.parent === parent));
      },

      async listChildBugs(parent) {
        return (await w.tracker.search({ parent })).map((i) => w.view(i));
      },
      async listFixes(parent) {
        // Abandoned CLs are not obligations; a CL counts as live only once fully rolled out.
        return (await w.pipeline.list(parent)).filter((c) => c.state !== 'abandoned').map((c) => ({
          clId: c.id, key: c.changeId, parent: c.parent, finding: c.finding, ref: c.ref, state: c.state === 'deployed' ? 'in-prod' : 'submitted',
        }));
      },
      async workflowStatus(id) {
        await w.rpc('workflow.describe');
        const started = sim.startedAt(id);
        // Visibility lags a fresh start by a second or two.
        if (started !== undefined && sim.now - started < rngFor(w.seed, 'visibility', id, started).lognormal(2_000, 0.5)) {
          w.stats.statusLag++;
          return 'unknown';
        }
        return sim.status(id);
      },
      async fileBug(req) {
        // No client idempotency token: search for the key first (the index lags), then create.
        const hit = (await w.tracker.search({ key: req.key }))[0];
        if (hit) return hit.id;
        return w.tracker.create({
          title: req.title, component: 'Experiments > Guardrails', priority: req.depth > 1 ? 'P2' : 'P1', reporter: 'agent',
          fields: { parent: req.parent, finding: req.finding, key: req.key, signature: req.signature, depth: req.depth },
        });
      },
      async submitFix(req) {
        return (await w.pipeline.upload({ changeId: req.key, parent: req.parent, finding: req.finding, ref: req.patch.ref })).id;
      },

      async getBug(id) { return w.view(await w.tracker.get(id)); },
      async analyze(bugId) { await w.analyze(bugId); },
      async verifyFix(bugId) { await w.rpc('analysis.verify'); return w.verify(bugId); },
      async closeBug(id, resolution, note) {
        const i = await w.tracker.get(id);
        if (i.status === 'DUPLICATE') return w.tracker.comment(id, 'agent', `${note} (this is a duplicate; ${i.duplicateOf} decides)`);
        if (!OPEN.has(i.status)) return;
        await w.tracker.update(id, 'agent', { status: resolution === 'fixed' ? 'FIXED' : 'WONTFIX' }, note);
      },
      async annotateBug(id, note) {
        await w.tracker.comment(id, 'agent', note);
        if (note.includes('needs a human')) w.onCall(id);
      },
      async escalateBug({ bugId, key, finding, reason }) {
        const i = await w.tracker.get(bugId);
        if (i.withPerson || i.comments.some((m) => m.text.includes(key))) return;
        await w.tracker.update(bugId, 'agent', { assignee: 'experiments-oncall', withPerson: { finding, since: sim.now } }, `Needs a person: ${reason} [${key}]`);
        w.onCall(bugId);
      },
    };
  }

  // ───────────────────────────── agents ─────────────────────────────

  /** Debugging-playbook triage: right about 80% of the time; on noise it still proposes something. */
  private triage(exp: Exp, failing: GuardrailReading[], _attempt: number): Triage {
    // It debugs the regression as a whole, starting from the most significant metric.
    const r = [...failing].sort((a, b) => b.value / b.threshold - a.value / a.threshold)[0]!;
    const truth = failing.map((x) => this.activeDefects(exp, x.guardrail, this.sim.now, x.arm)[0]).find(Boolean);
    let route: Triage['route'];
    let ref = `noop:${r.guardrail}`;
    if (!truth) {
      this.stats.falseAlarms++;
      const x = this.agents.next();
      route = x < 0.55 ? 'investigate' : x < 0.85 ? 'quick-fix' : 'escalate';
    } else if (this.agents.chance(0.8)) {
      route = truth.route;
      if (route === 'quick-fix') ref = truth.id;
    } else {
      this.stats.misroutes++;
      route = this.agents.pick(ROUTES.filter((x) => x !== truth.route));
    }
    if (route === 'quick-fix') return { route, patch: { summary: `mitigate ${r.guardrail} regression (${r.value}%)`, ref } };
    if (route === 'investigate') return { route, title: `[${failing.map((x) => x.guardrail).join(', ')}] ${r.guardrail} ${r.value}% vs threshold ${r.threshold}% in experiment`, hypothesis: 'regression introduced by the treatment' };
    return { route, reason: `no automated playbook for ${r.guardrail} at ${r.value}%` };
  }

  /** Agentic RCA: hours long; sometimes inconclusive, sometimes wrong, sometimes misses a prerequisite. */
  private async analyze(bugId: string) {
    const issue = this.tracker.issues.get(bugId)!;
    const truth = issue.truth ? this.defects.get(issue.truth) : undefined;
    await this.sim.sleep(this.agents.lognormal((truth?.analysisHours ?? 10) * HOUR, 0.5));
    const x = this.agents.next();
    let rc: RootCause | undefined;
    if (!truth || x < 0.12) {
      if (truth || x < 0.7) this.stats.rcaInconclusive++;
      else { this.stats.rcaWrong++; rc = { summary: 'attributed to a config change', fix: { summary: 'revert config change', ref: 'noop:config' } }; }
    } else if (x < 0.22) {
      this.stats.rcaWrong++;
      rc = { summary: 'misattributed to a dependency upgrade', fix: { summary: 'pin dependency', ref: `noop:${truth.id}` } };
    } else {
      const req = truth.requires ? this.defects.get(truth.requires) : undefined;
      const needsReq = req && this.cureFraction(req, this.sim.now) < 1;
      const missed = needsReq && this.agents.chance(0.2);
      if (missed) this.stats.rcaMissedPrereq++;
      rc = {
        summary: `root cause: ${truth.signature}`,
        fix: { summary: `patch ${truth.id}`, ref: truth.id },
        requires: needsReq && !missed ? { title: `prerequisite: ${req!.signature}`, signature: req!.signature } : undefined,
      };
    }
    if (rc) await this.tracker.update(bugId, 'rca-agent', { rootCause: rc }, `RCA: ${rc.summary}`);
    else await this.tracker.comment(bugId, 'rca-agent', 'RCA inconclusive: could not attribute the regression.');
  }

  /**
   * Verification of a live fix: a repro at the load that triggers the defect, or the signal
   * the bug was filed for. Needs a soak after the newest fix lands; right about 95% of the time.
   * A bug with nothing real behind it (noise) doesn't reproduce.
   */
  private verify(bugId: string): Verification {
    const issue = this.tracker.issues.get(bugId)!;
    const landed = Math.max(0, ...[...this.pipeline.cls.values()]
      .filter((c) => c.parent === `bug:${bugId}` && c.deployedAt !== undefined).map((c) => c.deployedAt!));
    if (this.sim.now - landed < VERIFY_SOAK) return { verdict: 'pending', detail: 'waiting for post-rollout data' };
    const truth = issue.truth ? this.defects.get(issue.truth) : undefined;
    const residual = truth ? 1 - this.cureFraction(truth, this.sim.now) : 0;
    let reproduces = residual > 0.05;
    if (this.verifier.chance(0.05)) { this.stats.verifyWrong++; reproduces = !reproduces; }
    else if (reproduces) this.stats.fixesIneffective++;
    const what = truth?.signature ?? issue.title;
    return reproduces
      ? { verdict: 'reproduces', detail: `${what} still reproduces with the fix live` }
      : { verdict: 'cured', detail: `${what} no longer reproduces` };
  }

  // ───────────────────────────── demo / reporting ─────────────────────────────

  snapshot(expId = 'E1') {
    const exp = this.exps.get(expId)!;
    return {
      stages: exp.history.map((h) => ({ at: h.at, effectiveAt: h.effectiveAt, percent: exp.stages[h.stage]!.percent, key: h.key, arm: h.arm })),
      bugs: [...this.tracker.issues.values()].map((i) => ({
        id: i.id, title: i.title, parent: i.fields.parent, depth: i.fields.depth, createdAt: i.createdAt, closedAt: i.closedAt,
        status: i.status as string, duplicateOf: i.duplicateOf, notes: i.comments.map((m) => `${m.author}: ${m.text}`),
      })),
      fixes: [...this.pipeline.cls.values()].map((c: Cl) => ({
        id: c.id, parent: c.parent, finding: c.finding, ref: c.ref, author: c.author, state: c.state,
        submittedAt: c.createdAt, inProdAt: c.deployedAt, phases: c.phases.map((p) => ({ ...p })),
      })),
      escalations: exp.escalations,
      pages: [...this.pages.values()].filter((p) => p.parent === `exp:${exp.flagName}`).map((p) => ({ ...p })),
      outages: this.metrics.outages,
      stats: { ...this.stats },
    };
  }

  private async rpc(method: string) {
    await this.sim.sleep(this.infra.lognormal(200, 0.6));
    if (this.infra.chance(0.01)) { this.stats.rpcErrors++; throw new TransientError(`UNAVAILABLE: ${method}`); }
  }
}
