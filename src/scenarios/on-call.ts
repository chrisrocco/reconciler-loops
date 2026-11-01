/**
 * Scenario 6 — an on-call agent (never ends): keep builds green and releases moving.
 * No goal and no time budget: it runs until someone cancels it, escalates what it can't fix
 * one finding at a time, and forgets old memory after a retention period.
 *
 *   findings  : `build:<target>@<first bad CL>`  a target broken since that CL
 *               `flaky:<test>`                   a test failing intermittently, not quarantined
 *               `quarantined:<test>`             lost coverage, until the owner fixes the test
 *               `canary:<release>:<alert>`       an alert firing on a release in canary
 *               `paused:<release>`               a release held back, until its fix lands
 *               `reverted:<CL>`                  a reverted change, until its owner relands it
 *   blockers  : an open issue for a finding (labeled with it) covers it and its follow-on finding
 *   respond   : mitigate locally (revert the culprit, quarantine the test, pause the release),
 *               delegate durably (one issue for the owner). If a revert doesn't turn the build
 *               green, revert the next suspect: mitigation goes on while the issue is open.
 *   repair    : a paused release whose issue is closed is resumed
 *
 * The first bad CL is in the build finding's id, so a later breakage of the same target is a
 * new finding with fresh attempts, not a continuation of last week's.
 */
import type { Blocker, Budget, Finding, ReconcilerSpec } from '../core/types.js';
import type { Runtime } from '../core/runtime.js';
import { reconcileToEnd, type RunOptions } from '../core/reconcile.js';
import { DAY, HOUR, MIN } from '../core/time.js';

export interface BrokenTarget { target: string; owner: string; firstBadCl: string; since: number; suspects: string[] }
export interface FlakyTest { test: string; owner: string; flakeRate: number; quarantined: boolean }
export interface Release { id: string; state: 'canary' | 'paused' | 'rolling-out' | 'done'; alerts: { alert: string; owner: string }[] }
export interface Revert { cl: string; key: string; target: string; owner: string; landedAt?: number; relandedAt?: number }
export interface OnCallIssue { id: string; key: string; parent: string; finding: string; owner: string; status: 'open' | 'closed'; createdAt: number; escalated?: boolean }

export interface OnCallActivities {
  brokenTargets(): Promise<BrokenTarget[]>;
  flakyTests(): Promise<FlakyTest[]>;
  releases(): Promise<Release[]>;
  reverts(): Promise<Revert[]>;
  listIssues(parent: string): Promise<OnCallIssue[]>;
  revert(cl: string, key: string): Promise<void>;
  quarantine(test: string, key: string): Promise<void>;
  pauseRelease(release: string, key: string): Promise<void>;
  resumeRelease(release: string, key: string): Promise<void>;
  fileIssue(req: { key: string; parent: string; finding: string; owner: string; title: string }): Promise<string>;
  /** Hand an issue's finding to the team lead. Idempotent on `key`. */
  escalateIssue(req: { key: string; parent: string; finding: string; reason: string }): Promise<void>;
}

export interface OnCallInput { team: string }

interface OnCallWorld { broken: BrokenTarget[]; flaky: FlakyTest[]; releases: Release[]; reverts: Revert[]; issues: OnCallIssue[] }
type OnCallFinding =
  | Finding<'build', BrokenTarget> | Finding<'flaky' | 'quarantined', FlakyTest>
  | Finding<'canary', { release: string; alert: string; owner: string }> | Finding<'paused', Release> | Finding<'reverted', Revert>;
type OnCallAction =
  | { key: string; kind: 'revert'; cl: string }
  | { key: string; kind: 'quarantine'; test: string }
  | { key: string; kind: 'pause'; release: string }
  | { key: string; kind: 'resume'; targets: string[]; release: string }
  | { key: string; kind: 'file-issue'; targets: string[]; finding: string; owner: string; title: string; deadlineMs: number };

// #region oncall-follow-on
/** The finding an issue's fix also clears: a quarantined test, a paused release, a reverted first bad CL. */
export const followOn = (finding: string) =>
  finding.startsWith('build:') ? [`reverted:${finding.split('@')[1]}`]
    : finding.startsWith('flaky:') ? [finding.replace(/^flaky:/, 'quarantined:')]
    : finding.startsWith('canary:') ? [`paused:${finding.split(':')[1]}`] : [];
// #endregion

export function onCallSpec(_rt: Runtime, acts: OnCallActivities, input: OnCallInput): ReconcilerSpec<OnCallWorld, OnCallFinding, OnCallAction> {
  const self = `oncall:${input.team}`;
  // No goal, no maxDurationMs: it never ends. Retention keeps its memory bounded.
  const budget: Budget = { maxAttemptsPerFinding: 3, maxFindingAgeMs: 3 * DAY, retentionMs: 14 * DAY, escalationDeadlineMs: HOUR };
  return {
    name: self,
    budget,

    // #region oncall-observe
    async observe() {
      const [broken, flaky, releases, reverts, issues] = await Promise.all([
        acts.brokenTargets(), acts.flakyTests(), acts.releases(), acts.reverts(), acts.listIssues(self),
      ]);
      const findings: OnCallFinding[] = [
        ...broken.map((b) => ({ id: `build:${b.target}@${b.firstBadCl}`, kind: 'build' as const, severity: 'blocking' as const, summary: `${b.target} red since ${b.firstBadCl}`, data: b })),
        ...flaky.map((t) => t.quarantined
          ? { id: `quarantined:${t.test}`, kind: 'quarantined' as const, severity: 'blocking' as const, summary: `${t.test} quarantined`, data: t }
          : { id: `flaky:${t.test}`, kind: 'flaky' as const, severity: 'blocking' as const, summary: `${t.test} flakes ${Math.round(t.flakeRate * 100)}%`, data: t }),
        ...releases.filter((r) => r.state === 'canary').flatMap((r) => r.alerts.map((a) => ({ id: `canary:${r.id}:${a.alert}`, kind: 'canary' as const, severity: 'blocking' as const, summary: `${a.alert} firing on ${r.id}`, data: { release: r.id, ...a } }))),
        ...releases.filter((r) => r.state === 'paused').map((r) => ({ id: `paused:${r.id}`, kind: 'paused' as const, severity: 'blocking' as const, summary: `${r.id} paused`, data: r })),
        ...reverts.filter((r) => r.landedAt !== undefined && r.relandedAt === undefined).map((r) => ({ id: `reverted:${r.cl}`, kind: 'reverted' as const, severity: 'blocking' as const, summary: `${r.cl} reverted, not relanded`, data: r })),
      ];
      const blockers: Blocker[] = issues.filter((i) => i.status === 'open').map((i) => ({
        id: `issue:${i.id}`, kind: i.escalated ? 'lead' : 'issue', on: [i.finding, ...followOn(i.finding)], scope: 'finding', summary: `${i.owner}: ${i.finding}`, since: i.createdAt,
      }));
      return { world: { broken, flaky, releases, reverts, issues }, findings, blockers };
    },
    // #endregion

    // #region oncall-plan
    plan(f) {
      const actions: OnCallAction[] = [];
      const n = (id: string) => (f.attempts[id] ?? 0) + 1;
      const issue = (x: OnCallFinding, finding: string, owner: string, title: string): OnCallAction =>
        ({ key: `issue:${x.id}:${n(x.id)}`, kind: 'file-issue', targets: [x.id], finding, owner, title, deadlineMs: HOUR });

      // Respond: mitigate locally (no targets, so it isn't an attempt), delegate durably (one issue).
      for (const x of f.open) {
        // #region oncall-build
        if (x.kind === 'build') {
          actions.push({ key: `revert:${x.data.suspects[0]}`, kind: 'revert', cl: x.data.suspects[0]! });
          actions.push(issue(x, x.id, x.data.owner, `${x.data.target} broken by ${x.data.firstBadCl}`));
        }
        // #endregion
        if (x.kind === 'flaky') {
          actions.push({ key: `quarantine:${x.data.test}:${n(x.id)}`, kind: 'quarantine', test: x.data.test });
          actions.push(issue(x, x.id, x.data.owner, `${x.data.test} is flaky`));
        }
        if (x.kind === 'quarantined') actions.push(issue(x, `flaky:${x.data.test}`, x.data.owner, `${x.data.test} is quarantined`));
        if (x.kind === 'reverted') actions.push(issue(x, x.id, x.data.owner, `reland ${x.data.cl}`));
        if (x.kind === 'canary') {
          actions.push({ key: `pause:${x.data.release}:${n(x.id)}`, kind: 'pause', release: x.data.release });
          actions.push(issue(x, x.id, x.data.owner, `${x.data.alert} on ${x.data.release}`));
        }
        // Repair: its issue is closed, so the fix has landed. Resume; if the alert comes back, it's a new attempt.
        if (x.kind === 'paused') actions.push({ key: `resume:${x.data.id}:${n(x.id)}`, kind: 'resume', targets: [x.id], release: x.data.id });
      }

      // #region oncall-next-suspect
      // Keep mitigating while the owner works: a revert that landed without turning the build green
      // means the first suspect was innocent. Revert the next one (its CL is in the key).
      for (const x of f.blocked) {
        if (x.kind !== 'build') continue;
        const reverted = x.data.suspects.filter((cl) => f.world.reverts.some((r) => r.cl === cl));
        const settled = reverted.every((cl) => f.world.reverts.some((r) => r.cl === cl && r.landedAt !== undefined && f.now - r.landedAt > 30 * MIN));
        const next = x.data.suspects.find((cl) => !reverted.includes(cl));
        if (reverted.length && settled && next) actions.push({ key: `revert:${next}`, kind: 'revert', cl: next });
      }
      // #endregion

      const counts = ['build', 'flaky', 'quarantined', 'canary', 'paused', 'reverted'].map((k) => `${f.findings.filter((x) => x.kind === k).length} ${k}`);
      return { actions, wake: { afterMs: 30 * MIN }, note: counts.join(', ') };
    },
    // #endregion

    async act(a) {
      switch (a.kind) {
        case 'revert': await acts.revert(a.cl, `${self}/${a.key}`); break;
        case 'quarantine': await acts.quarantine(a.test, `${self}/${a.key}`); break;
        case 'pause': await acts.pauseRelease(a.release, `${self}/${a.key}`); break;
        case 'resume': await acts.resumeRelease(a.release, `${self}/${a.key}`); break;
        case 'file-issue': await acts.fileIssue({ key: `${self}/${a.key}`, parent: self, finding: a.finding, owner: a.owner, title: a.title }); break;
        case 'escalate': await acts.escalateIssue({ key: `${self}/${a.key}`, parent: self, finding: a.finding, reason: a.reason }); break;
      }
    },
  };
}

export async function onCallWorkflow(rt: Runtime, acts: OnCallActivities, input: OnCallInput & { memory?: any }, opts: RunOptions = {}) {
  const out = await reconcileToEnd(rt, onCallSpec(rt, acts, input), { maxTicksPerRun: 200, memory: input.memory, ...opts });
  return { status: out.status, reason: out.reason };
}
