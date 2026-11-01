/**
 * Fake engineering org for the on-call loop: CI targets that break, tests that turn flaky, a
 * daily release with a canary, an issue tracker, and owners who fix their issues — or don't,
 * until their lead does. Seeded, so a run is reproducible.
 */
import { DAY, HOUR, MIN, type Sim } from '../runtime/sim.js';
import { followOn, type BrokenTarget, type OnCallActivities, type OnCallIssue, type Release, type Revert } from '../scenarios/on-call.js';
import { Rng, rngFor } from './realistic/rng.js';

const TEAMS = ['search', 'checkout', 'ads', 'maps'];
const TARGETS = TEAMS.map((t) => `//${t}:server`);
const TESTS = TEAMS.flatMap((t) => [`${t}/integration_test`, `${t}/e2e_test`]);
const ALERTS = ['error_ratio', 'latency_p99', 'crash_loop'];

export interface OnCallStats { breaks: number; wrongSuspect: number; flakes: number; badReleases: number; ignored: number; leadFixes: number }

export class OnCallWorld {
  readonly broken = new Map<string, BrokenTarget & { culprit: string }>();
  readonly flaky = new Map<string, { test: string; owner: string; flakeRate: number; quarantined: boolean }>();
  readonly releases: (Release & { cutAt: number; bad?: { alert: string; owner: string } })[] = [];
  readonly reverts: Revert[] = [];
  readonly issues = new Map<string, OnCallIssue>();
  readonly stats: OnCallStats = { breaks: 0, wrongSuspect: 0, flakes: 0, badReleases: 0, ignored: 0, leadFixes: 0 };
  /** Every red stretch of a target, for time-to-green. */
  readonly redSpans: { target: string; from: number; to?: number }[] = [];
  private keys = new Set<string>();
  private seq = { cl: 4_000, issue: 0, rel: 0 };
  private rng: Rng;
  private people: Rng;

  constructor(private sim: Sim, seed = 1, private days = 90) {
    this.rng = rngFor(seed, 'oncall-events');
    this.people = rngFor(seed, 'oncall-people');
    this.schedule();
  }

  private schedule() {
    // Breakages about every 2.5 days, a new flaky test every 4, a release cut every weekday morning.
    for (let t = this.rng.uniform(4, 30) * HOUR; t < this.days * DAY; t += this.rng.lognormal(60 * HOUR, 0.5)) this.sim.at(t, () => this.breakBuild());
    for (let t = this.rng.uniform(1, 3) * DAY; t < this.days * DAY; t += this.rng.lognormal(4 * DAY, 0.5)) this.sim.at(t, () => this.flake());
    for (let d = 0; d < this.days; d++) if (d % 7 < 5) this.sim.at(d * DAY + 9 * HOUR, () => this.cutRelease());
  }

  private cl() { return `cl/${++this.seq.cl}`; }

  private breakBuild() {
    const i = Math.floor(this.rng.uniform(0, TARGETS.length));
    const target = TARGETS[i]!;
    if (this.broken.has(target)) return;
    const culprit = this.cl(), bystander = this.cl();
    // Blame points at the wrong CL about a third of the time.
    const wrong = this.rng.chance(0.33);
    if (wrong) this.stats.wrongSuspect++;
    this.stats.breaks++;
    this.broken.set(target, { target, owner: TEAMS[i]!, firstBadCl: wrong ? bystander : culprit, since: this.sim.now, suspects: wrong ? [bystander, culprit] : [culprit, bystander], culprit });
    this.redSpans.push({ target, from: this.sim.now });
  }

  private green(target: string) {
    if (!this.broken.delete(target)) return;
    const span = [...this.redSpans].reverse().find((s) => s.target === target && s.to === undefined);
    if (span) span.to = this.sim.now;
  }

  private flake() {
    const fresh = TESTS.filter((t) => !this.flaky.has(t));
    if (!fresh.length) return;
    const test = fresh[Math.floor(this.rng.uniform(0, fresh.length))]!;
    this.stats.flakes++;
    this.flaky.set(test, { test, owner: test.split('/')[0]!, flakeRate: this.rng.uniform(0.05, 0.3), quarantined: false });
  }

  private cutRelease() {
    const id = `rel-${++this.seq.rel}`;
    const bad = this.rng.chance(0.2) ? { alert: ALERTS[Math.floor(this.rng.uniform(0, ALERTS.length))]!, owner: TEAMS[Math.floor(this.rng.uniform(0, TEAMS.length))]! } : undefined;
    if (bad) this.stats.badReleases++;
    const r = { id, state: 'canary' as Release['state'], alerts: [] as Release['alerts'], cutAt: this.sim.now, bad };
    this.releases.push(r);
    // The alert fires two hours into the canary; a healthy canary promotes after six.
    if (bad) this.sim.timer(2 * HOUR, () => { if (r.state === 'canary') r.alerts = [bad]; });
    this.sim.timer(6 * HOUR, () => this.promote(r));
  }

  private promote(r: OnCallWorld['releases'][number]) {
    if (r.state !== 'canary' || r.alerts.length) return;
    r.state = 'rolling-out';
    this.sim.timer(DAY, () => { r.state = 'done'; });
  }

  /** An owner works their issue: most fix it in a day or three; some never get to it. */
  private ownerResponds(issue: OnCallIssue) {
    if (this.people.chance(0.15)) { this.stats.ignored++; return; }
    this.sim.timer(this.people.lognormal(30 * HOUR, 0.6), () => this.fix(issue));
  }

  private fix(issue: OnCallIssue) {
    if (issue.status !== 'open') return;
    issue.status = 'closed';
    const [kind, a] = issue.finding.split(':');
    if (kind === 'build') {
      const [target, cl] = issue.finding.slice(6).split('@');
      this.green(target!);
      this.reland(cl!);
    }
    if (kind === 'reverted') this.reland(a!);
    if (kind === 'flaky') this.flaky.delete(a!);
    if (kind === 'canary') { const r = this.releases.find((x) => x.id === a); if (r) r.bad = undefined; }
    this.sim.log('issues', `${issue.id} closed by ${issue.escalated ? 'lead' : issue.owner}`);
  }

  /** The owner relands a reverted change, fixed. */
  private reland(cl: string) {
    const r = this.reverts.find((x) => x.cl === cl);
    if (r && r.relandedAt === undefined) r.relandedAt = this.sim.now;
  }

  private once(key: string) { if (this.keys.has(key)) return false; this.keys.add(key); return true; }

  activities(): OnCallActivities {
    const w = this;
    return {
      async brokenTargets() { return [...w.broken.values()].map(({ culprit, ...b }) => structuredClone(b)); },
      async flakyTests() { return [...w.flaky.values()].map((t) => ({ ...t })); },
      async releases() { return w.releases.filter((r) => r.state !== 'done').map(({ cutAt, bad, ...r }) => structuredClone(r)); },
      async reverts() { return w.reverts.map((r) => ({ ...r })); },
      async listIssues(parent) { return [...w.issues.values()].filter((i) => i.parent === parent).map((i) => ({ ...i })); },
      async revert(cl, key) {
        if (!w.once(key) || w.reverts.some((r) => r.cl === cl)) return;
        const b = [...w.broken.values()].find((x) => x.suspects.includes(cl));
        const r: Revert = { cl, key, target: b?.target ?? '?', owner: b?.owner ?? 'unknown' };
        w.reverts.push(r);
        // Presubmit and submit take about 20 minutes; the target goes green if this was the culprit.
        w.sim.timer(20 * MIN, () => {
          r.landedAt = w.sim.now;
          for (const b of w.broken.values()) if (b.culprit === cl) w.green(b.target);
        });
      },
      async quarantine(test, key) { if (w.once(key)) { const t = w.flaky.get(test); if (t) t.quarantined = true; } },
      async pauseRelease(id, key) {
        if (!w.once(key)) return;
        const r = w.releases.find((x) => x.id === id);
        if (r?.state === 'canary') { r.state = 'paused'; r.alerts = []; } // pausing rolls the canary back
      },
      async resumeRelease(id, key) {
        if (!w.once(key)) return;
        const r = w.releases.find((x) => x.id === id);
        if (r?.state !== 'paused') return;
        r.state = 'canary';
        if (r.bad) { const bad = r.bad; w.sim.timer(2 * HOUR, () => { if (r.state === 'canary') r.alerts = [bad]; }); }
        w.sim.timer(6 * HOUR, () => w.promote(r));
      },
      async fileIssue(req) {
        const existing = [...w.issues.values()].find((i) => i.key === req.key);
        if (existing) return existing.id;
        const issue: OnCallIssue = { id: `I-${++w.seq.issue}`, key: req.key, parent: req.parent, finding: req.finding, owner: req.owner, status: 'open', createdAt: w.sim.now };
        w.issues.set(issue.id, issue);
        w.ownerResponds(issue);
        return issue.id;
      },
      async escalateIssue({ key, parent, finding }) {
        if (!w.once(key)) return;
        const issue = [...w.issues.values()].find((i) => i.parent === parent && i.status === 'open' && (i.finding === finding || followOn(i.finding).includes(finding)));
        if (!issue || issue.escalated) return;
        issue.escalated = true;
        w.stats.leadFixes++;
        w.sim.timer(DAY, () => w.fix(issue));
      },
    };
  }
}
