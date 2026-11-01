/**
 * Scenario 5 — large-scale migration (months): move a codebase from one framework to another.
 * Loops nest: a campaign loop starts one child loop per component.
 *
 * Campaign
 *   desired state : no component left on the old framework, and the cleanup has run
 *   findings      : `legacy:<path>` per component still on the old framework; `allowlist-stale`
 *   blockers      : a migration change in progress (labeled with the campaign) covers its component;
 *                   `needs:<dependency>` is a PREREQUISITE: wait until the old-framework components
 *                   it uses have moved. Neither holds the loop: other components keep going
 *   respond       : start a child migration for each ready component, within work-in-progress
 *                   limits (in flight overall, per owner), smallest first; shrink the allowlist
 *   progress      : on a clean frame with nothing left, run the cleanup
 *
 * Component (child)
 *   desired state : the component is gone from the old framework (submitted, or migrated by hand)
 *   findings      : `unconverted`, `conflict` (it changed under the conversion), `check:<name>`
 *                   (build / tests / visual diff failing), `comment:<id>` (a reviewer's comment)
 *   blockers      : waiting on the reviewer; the component's team, once escalated to them
 *   progress      : clean and verified → request review; approved → submit
 */
import type { Blocker, Budget, Finding, ReconcilerSpec } from '../core/types.js';
import type { Runtime } from '../core/runtime.js';
import { reconcileToEnd, type RunOptions } from '../core/reconcile.js';
import { DAY, HOUR } from '../core/time.js';
import type { WorkflowStatus } from './systems.js';

/** A component still on the old framework, as code search and the build graph show it. */
export interface LegacyComponent {
  path: string;
  owner: string;
  /** Old-framework components it uses: they must move first. */
  uses: string[];
  lines: number;
  /** Last change to the component's code. A conversion of an older version conflicts. */
  changedAt: number;
}

export type CheckName = 'build' | 'tests' | 'visual';

/** A migration change in the code review system, labeled with the campaign and the component. */
export interface MigrationChange {
  id: string;
  key: string;
  parent: string;
  path: string;
  owner: string;
  state: 'open' | 'submitted' | 'abandoned';
  /** Bumped by every new patchset (convert, fix, address comments). */
  rev: number;
  /** The component version the conversion was made from; undefined until converted. */
  baseAt?: number;
  review: 'none' | 'requested' | 'approved';
  requestedAt?: number;
  comments: { id: string; body: string; resolved: boolean }[];
  /** Escalated: the owning team has it. */
  withTeam?: { since: number; reason: string };
  createdAt: number;
}

export interface MigrationActivities {
  listLegacy(): Promise<LegacyComponent[]>;
  listChanges(parent: string): Promise<MigrationChange[]>;
  workflowStatus(workflowId: string): Promise<WorkflowStatus>;
  getAllowlist(): Promise<string[]>;
  setAllowlist(paths: string[], key: string): Promise<void>;
  runCleanup(key: string): Promise<void>;
  cleanupState(): Promise<'not-started' | 'running' | 'done'>;
  /** Hand a component to its owning team, with notes from the attempts. Idempotent on `key`. */
  escalateToTeam(req: { parent: string; path: string; reason: string; key: string }): Promise<void>;

  getComponent(path: string): Promise<LegacyComponent | undefined>;
  /** Agent: rewrite the component on the new framework, as a new patchset on its change (created if needed). Long-running. */
  convert(req: { parent: string; path: string; attempt: number; key: string }): Promise<void>;
  /** Build, tests and a screenshot comparison of the change's latest patchset. */
  verify(changeId: string): Promise<Record<CheckName, 'pass' | 'fail'>>;
  /** Agent: fix one failing check. */
  fixCheck(changeId: string, check: CheckName, attempt: number, key: string): Promise<void>;
  requestReview(changeId: string, key: string): Promise<void>;
  /** Agent: address reviewer comments in a new patchset and resolve them. */
  addressComments(changeId: string, commentIds: string[], key: string): Promise<void>;
  submit(changeId: string, key: string): Promise<void>;
}

export const migrationId = (path: string) => `migrate:${path}`;

// ───────────────────────────── campaign ─────────────────────────────

export interface CampaignInput {
  name: string;
  /** Changes in flight at once, overall and per owner. */
  maxInFlight?: number;
  maxPerOwner?: number;
}

interface CampaignWorld {
  legacy: LegacyComponent[]; changes: MigrationChange[]; allowlist: string[];
  cleanup: 'not-started' | 'running' | 'done'; children: Record<string, WorkflowStatus>;
}
type CampaignFinding = Finding<'legacy', LegacyComponent> | Finding<'allowlist-stale', string[]>;
type CampaignAction =
  | { key: string; kind: 'start-migration'; targets: string[]; path: string; deadlineMs: number }
  | { key: string; kind: 'restart-migration'; path: string }
  | { key: string; kind: 'shrink-allowlist'; targets: string[]; paths: string[] }
  | { key: string; kind: 'cleanup' };

export function campaignSpec(rt: Runtime, acts: MigrationActivities, input: CampaignInput): ReconcilerSpec<CampaignWorld, CampaignFinding, CampaignAction> {
  const self = `campaign:${input.name}`;
  const maxInFlight = input.maxInFlight ?? 6;
  const maxPerOwner = input.maxPerOwner ?? 2;
  const budget: Budget = { maxDurationMs: 180 * DAY, maxAttemptsPerFinding: 3, maxFindingAgeMs: 21 * DAY, retentionMs: 30 * DAY, escalationDeadlineMs: HOUR };
  return {
    name: self,
    budget,

    async observe() {
      const [legacy, changes, allowlist, cleanup] = await Promise.all([acts.listLegacy(), acts.listChanges(self), acts.getAllowlist(), acts.cleanupState()]);
      const open = changes.filter((c) => c.state === 'open');
      const children = Object.fromEntries(await Promise.all(open.map(async (c) => [c.path, await acts.workflowStatus(migrationId(c.path))] as const)));
      const remaining = new Set(legacy.map((c) => c.path));
      const findings: CampaignFinding[] = legacy.map((c) => ({ id: `legacy:${c.path}`, kind: 'legacy', severity: 'blocking', summary: `${c.path} (${c.lines} lines, ${c.owner})`, data: c }));
      const stale = allowlist.filter((p) => !remaining.has(p));
      if (stale.length) findings.push({ id: 'allowlist-stale', kind: 'allowlist-stale', severity: 'advisory', summary: `${stale.length} migrated paths still allowlisted`, data: stale });
      const blockers: Blocker[] = [
        ...open.map((c) => ({ id: `migration:${c.id}`, kind: c.withTeam ? 'team' : 'migration', on: [`legacy:${c.path}`], scope: 'finding' as const, summary: c.withTeam ? `with ${c.owner}` : `migrating (${c.review})`, since: c.withTeam?.since ?? c.createdAt })),
        // Prerequisites: wait for the old-framework components this one uses. These never age.
        ...legacy.flatMap((c) => c.uses.filter((d) => remaining.has(d)).map((d) => ({ id: `needs:${d}`, kind: 'prerequisite', on: [`legacy:${c.path}`], scope: 'finding' as const, summary: `${c.path} uses ${d}`, prerequisite: true }))),
      ];
      return { world: { legacy, changes, allowlist, cleanup, children }, findings, blockers };
    },

    done: (f) => (!f.world.legacy.length && f.world.cleanup === 'done' ? 'migrated, and the old framework removed' : undefined),

    plan(f) {
      const { legacy, changes, children, cleanup } = f.world;
      const actions: CampaignAction[] = [];
      const open = changes.filter((c) => c.state === 'open');

      // 1. Repair: a migration in progress whose child loop died (not one its team has).
      for (const c of open) if (!c.withTeam && (children[c.path] === 'unknown' || children[c.path] === 'terminated'))
        actions.push({ key: `restart:${c.path}@${f.tick}`, kind: 'restart-migration', path: c.path });

      // 2. Respond, within work-in-progress limits: smallest first. The rest stay open, untouched.
      // Claimed findings count as in flight too: their child has started but its change isn't listed yet.
      const claimed = f.claimed.flatMap((x) => (x.kind === 'legacy' ? [x.data] : []));
      let inFlight = open.filter((c) => !c.withTeam).length + claimed.length;
      const perOwner: Record<string, number> = {};
      for (const c of [...open.filter((c) => !c.withTeam), ...claimed]) perOwner[c.owner] = (perOwner[c.owner] ?? 0) + 1;
      const ready = f.open.flatMap((x) => (x.kind === 'legacy' ? [x] : [])).sort((a, b) => a.data.lines - b.data.lines);
      for (const x of ready) {
        if (inFlight >= maxInFlight) break;
        if ((perOwner[x.data.owner] ?? 0) >= maxPerOwner) continue;
        actions.push({ key: `migrate:${x.data.path}:${(f.attempts[x.id] ?? 0) + 1}`, kind: 'start-migration', targets: [x.id], path: x.data.path, deadlineMs: HOUR });
        inFlight++;
        perOwner[x.data.owner] = (perOwner[x.data.owner] ?? 0) + 1;
      }
      const stale = f.open.find((x) => x.kind === 'allowlist-stale');
      if (stale) actions.push({ key: `allowlist:${legacy.length}`, kind: 'shrink-allowlist', targets: [stale.id], paths: legacy.map((c) => c.path) });

      // 3. Move forward: nothing left and nothing outstanding → remove the bridge and the old framework.
      if (!legacy.length && !f.blockers.length && !f.claimed.length && cleanup === 'not-started') actions.push({ key: 'cleanup', kind: 'cleanup' });
      return {
        actions, wake: { afterMs: 2 * HOUR, signals: ['child-closed'] },
        note: `${legacy.length} left, ${open.length} in flight, ${f.open.filter((x) => x.kind === 'legacy').length} ready`,
      };
    },

    async act(a) {
      switch (a.kind) {
        case 'start-migration':
        case 'restart-migration':
          await rt.startChild({ workflowId: migrationId(a.path), workflow: 'component-migration', input: { path: a.path, parent: self, parentWorkflowId: rt.workflowId } satisfies ComponentInput });
          break;
        case 'shrink-allowlist': await acts.setAllowlist(a.paths, `${self}/${a.key}`); break;
        case 'cleanup': await acts.runCleanup(`${self}/${a.key}`); break;
        case 'escalate': {
          const path = a.finding.replace(/^legacy:/, '');
          await acts.escalateToTeam({ parent: self, path, reason: a.reason, key: `${self}/${a.key}` });
          break;
        }
      }
    },
  };
}

export async function campaignWorkflow(rt: Runtime, acts: MigrationActivities, input: CampaignInput & { memory?: any }, opts: RunOptions = {}) {
  const out = await reconcileToEnd(rt, campaignSpec(rt, acts, input), { maxTicksPerRun: 100, memory: input.memory, ...opts });
  return out.status === 'done' ? { status: 'done', reason: out.reason } : { status: out.status, reason: out.reason };
}

// ───────────────────────────── component ─────────────────────────────

export interface ComponentInput { path: string; parent: string; parentWorkflowId: string }

interface ComponentWorld { component?: LegacyComponent; change?: MigrationChange; checks?: Record<CheckName, 'pass' | 'fail'> }
type ComponentFinding = Finding<'unconverted' | 'conflict' | 'check' | 'comment', { check?: CheckName; commentId?: string }>;
type ComponentAction =
  | { key: string; kind: 'convert'; targets: string[] }
  | { key: string; kind: 'fix-check'; targets: string[]; check: CheckName }
  | { key: string; kind: 'address'; targets: string[]; commentIds: string[] }
  | { key: string; kind: 'request-review' }
  | { key: string; kind: 'submit' };

export function componentSpec(rt: Runtime, acts: MigrationActivities, input: ComponentInput): ReconcilerSpec<ComponentWorld, ComponentFinding, ComponentAction> {
  const self = `${input.parent}/${input.path}`;
  return {
    name: migrationId(input.path),
    budget: { maxDurationMs: 30 * DAY, maxAttemptsPerFinding: 3, escalationDeadlineMs: HOUR },

    async observe({ memo }) {
      const component = await acts.getComponent(input.path);
      const change = (await acts.listChanges(input.parent)).find((c) => c.path === input.path && c.state === 'open');
      if (!component) return { world: { change }, findings: [], blockers: [] };
      const findings: ComponentFinding[] = [];
      const blockers: Blocker[] = [];
      let checks: ComponentWorld['checks'];
      if (change?.withTeam) blockers.push({ id: `team:${input.path}`, kind: 'team', on: [], scope: 'loop', summary: `with ${change.owner}: ${change.withTeam.reason}`, since: change.withTeam.since });
      else if (!change || change.baseAt === undefined) findings.push({ id: 'unconverted', kind: 'unconverted', severity: 'blocking', summary: 'not converted yet', data: {} });
      // Changed underneath the conversion: a new finding, with fresh attempts — convert again on the new code.
      else if (change.baseAt < component.changedAt) findings.push({ id: `conflict@${component.changedAt}`, kind: 'conflict', severity: 'blocking', summary: 'the component changed since it was converted', data: {} });
      else {
        // Compiling is not the same as working: verify every patchset (once per patchset).
        checks = await memo.get(`verify:${change.id}@${change.rev}`, () => acts.verify(change.id));
        for (const [name, v] of Object.entries(checks)) if (v === 'fail')
          findings.push({ id: `check:${name}`, kind: 'check', severity: 'blocking', summary: `${name} failing`, data: { check: name as CheckName } });
        for (const c of change.comments.filter((c) => !c.resolved))
          findings.push({ id: `comment:${c.id}`, kind: 'comment', severity: 'blocking', summary: c.body, data: { commentId: c.id } });
        if (change.review === 'requested' && !change.comments.some((c) => !c.resolved))
          blockers.push({ id: `reviewer:${change.id}`, kind: 'reviewer', on: [], scope: 'loop', summary: `waiting on ${change.owner}`, since: change.requestedAt });
      }
      return { world: { component, change, checks }, findings, blockers };
    },

    done: (f) => (!f.world.component ? (f.world.change?.state === 'submitted' ? 'submitted' : 'migrated') : undefined),

    plan(f) {
      const actions: ComponentAction[] = [];
      const n = (id: string) => (f.attempts[id] ?? 0) + 1;
      for (const x of f.open) {
        if (x.kind === 'unconverted' || x.kind === 'conflict') actions.push({ key: `convert:${x.id}:${n(x.id)}`, kind: 'convert', targets: [x.id] });
        if (x.kind === 'check') actions.push({ key: `fix:${x.id}:${n(x.id)}`, kind: 'fix-check', targets: [x.id], check: x.data.check! });
      }
      const comments = f.open.filter((x) => x.kind === 'comment');
      if (comments.length) {
        const ids = comments.map((x) => x.id).sort();
        actions.push({ key: `address:${ids.join(',')}:${Math.max(...ids.map(n))}`, kind: 'address', targets: ids, commentIds: comments.map((x) => x.data.commentId!) });
      }
      // Move forward on a clean frame: verified → ask for review; approved → submit.
      const c = f.world.change;
      if (c && !f.findings.length && !f.blockers.length && !f.claimed.length && f.world.checks) {
        if (c.review === 'none') actions.push({ key: `review:r${c.rev}`, kind: 'request-review' });
        if (c.review === 'approved') actions.push({ key: `submit:r${c.rev}`, kind: 'submit' });
      }
      return { actions, wake: { afterMs: f.held ? 4 * HOUR : HOUR }, note: c ? `r${c.rev} ${c.review}` : undefined };
    },

    async act(a, f) {
      const change = f.world.change;
      switch (a.kind) {
        case 'convert': await acts.convert({ parent: input.parent, path: input.path, attempt: (f.attempts[a.targets[0]!] ?? 0) + 1, key: `${self}/${a.key}` }); break;
        case 'fix-check': await acts.fixCheck(change!.id, a.check, (f.attempts[a.targets[0]!] ?? 0) + 1, `${self}/${a.key}`); break;
        case 'address': await acts.addressComments(change!.id, a.commentIds, `${self}/${a.key}`); break;
        case 'request-review': await acts.requestReview(change!.id, `${self}/${a.key}`); break;
        case 'submit': await acts.submit(change!.id, `${self}/${a.key}`); break;
        case 'escalate':
          await acts.escalateToTeam({ parent: input.parent, path: input.path, reason: `${a.finding}: ${a.reason}`, key: `${self}/${a.key}` });
          break;
      }
    },
  };
}

export async function componentMigrationWorkflow(rt: Runtime, acts: MigrationActivities, input: ComponentInput & { memory?: any }, opts: RunOptions = {}) {
  const out = await reconcileToEnd(rt, componentSpec(rt, acts, input), { maxTicksPerRun: 200, memory: input.memory, ...opts });
  // Out of time: the component's team takes it, with the notes so far.
  if (out.status !== 'done') await acts.escalateToTeam({ parent: input.parent, path: input.path, reason: `migration ${out.status}: ${out.reason}`, key: `${input.parent}/${input.path}/safe-hold` });
  await rt.hint(input.parentWorkflowId, 'child-closed');
  return { status: out.status };
}

