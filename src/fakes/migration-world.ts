/**
 * Fake codebase for the migration loops: code search over the old framework, a code review
 * system holding migration changes, CI checks, reviewers, owning teams, and the allowlist.
 * Each component has a `kind` that decides how its migration goes.
 */
import { DAY, HOUR, type Sim } from '../runtime/sim.js';
import type { CheckName, LegacyComponent, MigrationActivities, MigrationChange } from '../scenarios/migration.js';

export type ComponentKind =
  /** The codemod converts it cleanly. */
  | 'codemod'
  /** Tests fail until the agent has fixed them twice. */
  | 'tests'
  /** One visual diff to fix. */
  | 'visual'
  /** The screenshot never matches: the agent escalates, and the team migrates it by hand. */
  | 'hard'
  /** Someone edits the component while its migration is in review: convert again. */
  | 'churn'
  /** A person migrates it by hand before the campaign gets to it. */
  | 'manual';

export interface ComponentSpec { path: string; owner: string; uses?: string[]; lines: number; kind: ComponentKind }

export class MigrationWorld {
  readonly legacy = new Map<string, LegacyComponent & { kind: ComponentKind }>();
  readonly changes = new Map<string, MigrationChange & { fixes: Partial<Record<CheckName, number>>; churned?: boolean }>();
  readonly migrated: { path: string; at: number; by: 'agent' | 'team' | 'person' }[] = [];
  readonly calls: Record<string, number> = {};
  allowlist: string[] = [];
  cleanup: { startedAt?: number; doneAt?: number } = {};
  reviewDelayMs = 8 * HOUR;
  teamDelayMs = 3 * DAY;
  private keys = new Set<string>();
  private seq = 0;

  constructor(private sim: Sim, components: ComponentSpec[]) {
    for (const c of components) {
      this.legacy.set(c.path, { path: c.path, owner: c.owner, uses: c.uses ?? [], lines: c.lines, changedAt: 0, kind: c.kind });
      if (c.kind === 'manual') sim.at(6 * HOUR, () => this.migrate(c.path, 'person'));
    }
    this.allowlist = components.map((c) => c.path);
  }

  private migrate(path: string, by: 'agent' | 'team' | 'person') {
    if (!this.legacy.delete(path)) return;
    this.migrated.push({ path, at: this.sim.now, by });
    this.sim.log('codebase', `${path} migrated by ${by}`);
  }
  private once(key: string) { if (this.keys.has(key)) return false; this.keys.add(key); return true; }
  private view(c: MigrationChange & { fixes: unknown; churned?: boolean }): MigrationChange {
    const { fixes, churned, ...v } = c as any;
    return structuredClone(v);
  }

  activities(): MigrationActivities {
    const w = this;
    const count = (n: string) => { w.calls[n] = (w.calls[n] ?? 0) + 1; };
    const change = (id: string) => w.changes.get(id)!;
    return {
      async listLegacy() { count('listLegacy'); return [...w.legacy.values()].map(({ kind, ...c }) => structuredClone(c)); },
      async listChanges(parent) { count('listChanges'); return [...w.changes.values()].filter((c) => c.parent === parent).map((c) => w.view(c)); },
      async workflowStatus(id) { count('workflowStatus'); return w.sim.status(id); },
      async getAllowlist() { return [...w.allowlist]; },
      async setAllowlist(paths, key) { count('setAllowlist'); if (w.once(key)) w.allowlist = [...paths]; },
      async runCleanup(key) {
        count('runCleanup');
        if (!w.once(key)) return;
        w.cleanup.startedAt = w.sim.now;
        w.sim.timer(DAY, () => { w.cleanup.doneAt = w.sim.now; w.sim.log('codebase', 'bridge code and old framework removed'); });
      },
      async cleanupState() { return w.cleanup.doneAt !== undefined ? 'done' : w.cleanup.startedAt !== undefined ? 'running' : 'not-started'; },
      async escalateToTeam({ parent, path, reason, key }) {
        count('escalateToTeam');
        if (!w.once(key)) return;
        let c = [...w.changes.values()].find((x) => x.parent === parent && x.path === path && x.state === 'open');
        if (!c) {
          const comp = w.legacy.get(path);
          if (!comp) return;
          c = { id: `CL-${++w.seq}`, key, parent, path, owner: comp.owner, state: 'open', rev: 0, review: 'none', comments: [], createdAt: w.sim.now, fixes: {} };
          w.changes.set(c.id, c);
        }
        c.withTeam = { since: w.sim.now, reason };
        w.sim.log('review', `${path} handed to ${c.owner}: ${reason}`);
        // The team migrates it by hand, and abandons the agent's change.
        const id = c.id;
        w.sim.timer(w.teamDelayMs, () => { w.migrate(path, 'team'); change(id).state = 'abandoned'; });
      },

      async getComponent(path) { const c = w.legacy.get(path); if (!c) return undefined; const { kind, ...v } = c; return structuredClone(v); },
      async convert({ parent, path, key }) {
        count('convert');
        if (!w.once(key)) return;
        const comp = w.legacy.get(path);
        if (!comp) return;
        // The change exists from the start (labeled), so the campaign sees the migration at once.
        let c = [...w.changes.values()].find((x) => x.parent === parent && x.path === path && x.state === 'open');
        if (!c) {
          c = { id: `CL-${++w.seq}`, key, parent, path, owner: comp.owner, state: 'open', rev: 0, review: 'none', comments: [], createdAt: w.sim.now, fixes: {} };
          w.changes.set(c.id, c);
          w.sim.log('review', `${c.id} created for ${path}`);
        }
        await w.sim.sleep(Math.max(1, comp.lines / 200) * HOUR);
        Object.assign(c, { rev: c.rev + 1, baseAt: comp.changedAt, review: 'none', comments: [], requestedAt: undefined });
      },
      async verify(id) {
        count('verify');
        const c = change(id);
        const kind = w.legacy.get(c.path)?.kind ?? 'codemod';
        await w.sim.sleep(HOUR);
        const fixed = (k: CheckName) => c.fixes[k] ?? 0;
        return {
          build: 'pass',
          tests: kind === 'tests' && fixed('tests') < 2 ? 'fail' : 'pass',
          visual: kind === 'hard' || (kind === 'visual' && fixed('visual') < 1) ? 'fail' : 'pass',
        };
      },
      async fixCheck(id, check, _attempt, key) {
        count('fixCheck');
        if (!w.once(key)) return;
        await w.sim.sleep(2 * HOUR);
        const c = change(id);
        c.fixes[check] = (c.fixes[check] ?? 0) + 1;
        c.rev++;
      },
      async requestReview(id, key) {
        count('requestReview');
        if (!w.once(key)) return;
        const c = change(id);
        Object.assign(c, { review: 'requested', requestedAt: w.sim.now });
        const rev = c.rev;
        const comp = w.legacy.get(c.path);
        // A churning component is edited by someone else while this is in review.
        if (comp?.kind === 'churn' && !c.churned) { c.churned = true; w.sim.timer(w.reviewDelayMs / 2, () => { comp.changedAt = w.sim.now; }); }
        w.sim.timer(w.reviewDelayMs, () => {
          if (c.rev !== rev || c.state !== 'open') return;
          // First look: big components get a comment; otherwise, and after comments are addressed, approve.
          if (!c.comments.length && (comp?.lines ?? 0) >= 600) c.comments.push({ id: `${c.id}#1`, body: 'please keep the old prop names as aliases', resolved: false });
          else c.review = 'approved';
        });
      },
      async addressComments(id, commentIds, key) {
        count('addressComments');
        if (!w.once(key)) return;
        await w.sim.sleep(HOUR);
        const c = change(id);
        for (const cm of c.comments) if (commentIds.includes(cm.id)) cm.resolved = true;
        c.rev++;
        const rev = c.rev;
        w.sim.timer(w.reviewDelayMs / 2, () => { if (c.rev === rev && c.state === 'open') c.review = 'approved'; });
      },
      async submit(id, key) {
        count('submit');
        if (!w.once(key)) return;
        const c = change(id);
        c.state = 'submitted';
        w.migrate(c.path, 'agent');
      },
    };
  }
}

/** A small app: 14 components across 4 teams, with a dependency graph and one of each kind of trouble. */
export const SAMPLE_APP: ComponentSpec[] = [
  { path: 'ui/Button', owner: 'design-system', lines: 120, kind: 'codemod' },
  { path: 'ui/Icon', owner: 'design-system', lines: 80, kind: 'codemod' },
  { path: 'ui/Input', owner: 'design-system', uses: ['ui/Icon'], lines: 340, kind: 'tests' },
  { path: 'ui/Modal', owner: 'design-system', uses: ['ui/Button'], lines: 450, kind: 'visual' },
  { path: 'ui/DatePicker', owner: 'design-system', uses: ['ui/Input', 'ui/Modal'], lines: 900, kind: 'hard' },
  { path: 'checkout/Cart', owner: 'checkout', uses: ['ui/Button'], lines: 640, kind: 'churn' },
  { path: 'checkout/Payment', owner: 'checkout', uses: ['ui/Input', 'ui/Modal'], lines: 780, kind: 'tests' },
  { path: 'checkout/Summary', owner: 'checkout', uses: ['checkout/Cart'], lines: 260, kind: 'codemod' },
  { path: 'search/Box', owner: 'search', uses: ['ui/Input'], lines: 300, kind: 'codemod' },
  { path: 'search/Results', owner: 'search', uses: ['search/Box'], lines: 720, kind: 'codemod' },
  { path: 'search/Filters', owner: 'search', uses: ['ui/DatePicker'], lines: 410, kind: 'visual' },
  { path: 'account/Profile', owner: 'accounts', uses: ['ui/Input'], lines: 380, kind: 'codemod' },
  { path: 'account/Settings', owner: 'accounts', uses: ['ui/Modal'], lines: 520, kind: 'manual' },
  { path: 'account/Avatar', owner: 'accounts', uses: ['ui/Icon'], lines: 90, kind: 'codemod' },
];
