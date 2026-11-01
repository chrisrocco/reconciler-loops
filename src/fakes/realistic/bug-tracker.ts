/**
 * Issue tracker, modeled on a large org's tracker:
 *
 * - Rich statuses: NEW / ASSIGNED / ACCEPTED are open; FIXED / VERIFIED are fixed;
 *   DUPLICATE points at a canonical issue; WONTFIX / INFEASIBLE / INTENDED_BEHAVIOR /
 *   OBSOLETE are closed without a fix.
 * - Linkage lives in custom fields (parent, finding, idempotency key, signature, depth).
 * - Search is served from an index that lags writes by tens of seconds; get-by-id is
 *   consistent.
 * - RPCs take a few hundred ms and occasionally fail with UNAVAILABLE. Create has no
 *   client idempotency token, and sometimes times out AFTER committing the issue.
 */
import type { Sim } from '../../runtime/sim.js';
import type { RootCause } from '../../scenarios/systems.js';
import type { Rng } from './rng.js';

export class TransientError extends Error {}

export type IssueStatus =
  | 'NEW' | 'ASSIGNED' | 'ACCEPTED' | 'FIXED' | 'VERIFIED'
  | 'DUPLICATE' | 'WONTFIX' | 'INFEASIBLE' | 'INTENDED_BEHAVIOR' | 'OBSOLETE';
export const OPEN: ReadonlySet<IssueStatus> = new Set(['NEW', 'ASSIGNED', 'ACCEPTED']);
export const FIXED: ReadonlySet<IssueStatus> = new Set(['FIXED', 'VERIFIED']);

export interface CustomFields { parent: string; finding: string; key: string; signature: string; depth: number }

export interface Issue {
  id: string;
  title: string;
  component: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  status: IssueStatus;
  reporter: string;
  assignee?: string;
  duplicateOf?: string;
  fields: CustomFields;
  createdAt: number;
  modifiedAt: number;
  closedAt?: number;
  closedBy?: string;
  comments: { at: number; author: string; text: string }[];
  rootCause?: RootCause;
  /** Set while the issue is handed to a person about one finding (an investigation escalated it). */
  withPerson?: { finding: string; since: number };
  /** Not visible through the API: when search starts returning this issue. */
  indexedAt: number;
  /** Ground truth, invisible to everyone: the defect this issue is really about, if any. */
  truth?: string;
}

export interface TrackerStats { rpcErrors: number; ambiguousCreates: number }

export class BugTracker {
  readonly issues = new Map<string, Issue>();
  /** Called synchronously when an issue is created, before any ambiguous timeout. */
  onCreate?: (issue: Issue) => void;
  private seq = 312_400_000;

  constructor(
    private sim: Sim,
    private rng: Rng,
    private stats: TrackerStats,
    private opts = { indexLagMedianMs: 40_000, rpcErrorRate: 0.01, ambiguousCreateRate: 0.02 },
  ) {}

  // ── API (what an adapter calls; every method can fail transiently) ──

  async search(q: Partial<CustomFields>): Promise<Issue[]> {
    await this.rpc('search');
    return [...this.issues.values()]
      .filter((i) => i.indexedAt <= this.sim.now && (Object.keys(q) as (keyof CustomFields)[]).every((k) => i.fields[k] === q[k]))
      .map((i) => structuredClone(i));
  }

  async get(id: string): Promise<Issue> {
    await this.rpc('get');
    const i = this.issues.get(id);
    if (!i) throw new Error(`NOT_FOUND: ${id}`);
    return structuredClone(i);
  }

  async create(input: { title: string; component: string; priority: Issue['priority']; reporter: string; fields: CustomFields }): Promise<string> {
    await this.rpc('create');
    const now = this.sim.now;
    const issue: Issue = {
      ...input, id: `b/${++this.seq}`, status: 'NEW', createdAt: now, modifiedAt: now, comments: [],
      indexedAt: now + this.rng.lognormal(this.opts.indexLagMedianMs, 0.8),
    };
    this.issues.set(issue.id, issue);
    this.onCreate?.(issue);
    if (this.rng.chance(this.opts.ambiguousCreateRate)) {
      this.stats.ambiguousCreates++;
      throw new TransientError('DEADLINE_EXCEEDED: create issue (the issue may have been created)');
    }
    return issue.id;
  }

  async comment(id: string, author: string, text: string) {
    await this.rpc('comment');
    this.edit(id, author, {}, text);
  }

  async update(id: string, author: string, patch: Partial<Pick<Issue, 'status' | 'assignee' | 'priority' | 'duplicateOf' | 'rootCause' | 'withPerson'>>, text?: string) {
    await this.rpc('update');
    this.edit(id, author, patch, text);
  }

  // ── people using the UI (no RPC faults) ──

  edit(id: string, author: string, patch: Partial<Issue>, text?: string) {
    const i = this.issues.get(id)!;
    const wasOpen = OPEN.has(i.status);
    Object.assign(i, patch, { modifiedAt: this.sim.now });
    if (wasOpen && !OPEN.has(i.status)) Object.assign(i, { closedAt: this.sim.now, closedBy: author });
    if (!wasOpen && OPEN.has(i.status)) i.closedAt = undefined;
    if (text) i.comments.push({ at: this.sim.now, author, text });
  }

  /** Follow DUPLICATE links to the issue that carries the real status. */
  canonical(id: string): Issue {
    let i = this.issues.get(id)!;
    for (let hops = 0; i.status === 'DUPLICATE' && i.duplicateOf && hops < 10; hops++) i = this.issues.get(i.duplicateOf)!;
    return i;
  }

  private async rpc(method: string) {
    await this.sim.sleep(this.rng.lognormal(250, 0.6));
    if (this.rng.chance(this.opts.rpcErrorRate)) {
      this.stats.rpcErrors++;
      throw new TransientError(`UNAVAILABLE: tracker.${method}`);
    }
  }
}
