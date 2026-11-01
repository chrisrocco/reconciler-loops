/**
 * A complete reconciler loop, small enough to read in one sitting: keep every TLS certificate
 * in a fleet renewed before it expires.
 *
 *   world      : the certificate inventory, renewal orders at the certificate authority, and pages
 *   findings   : `expiring:<cert>@<expiresAt>`, a certificate within 14 days of expiry. The expiry
 *                is in the id, so once a certificate is renewed, its next expiry is a new finding
 *   blockers   : a pending renewal order covers its finding; so does an open page to the owner
 *   respond    : order a renewal. The key carries the attempt number, and the finding stays
 *                claimed until the order shows up at the certificate authority
 *   escalation : three orders that didn't renew it, or a week unresolved → page the owner
 *   goal       : none. It runs until cancelled; retention keeps its memory bounded
 *
 * test/cert-renewal.test.ts runs it against a fake certificate authority.
 */
import { reconcileToEnd, type RunOptions } from '../src/core/reconcile.js';
import type { Runtime } from '../src/core/runtime.js';
import type { Blocker, Finding, LoopMemory, ReconcilerSpec } from '../src/core/types.js';
import { DAY, HOUR } from '../src/core/time.js';

// #region cert-world
// What the systems of record show. Everything the loop files carries `parent` (the loop)
// and `finding`, so a fresh run with no memory finds its own work.
export interface Certificate { name: string; owner: string; expiresAt: number }
export interface RenewalOrder {
  id: string; key: string; parent: string; finding: string;
  status: 'pending' | 'issued' | 'failed'; createdAt: number;
}
export interface Page { id: string; key: string; parent: string; finding: string; status: 'open' | 'resolved'; openedAt: number }

/** Every read and every effect. Effects are idempotent on `key` at the destination. */
export interface CertActivities {
  listCertificates(): Promise<Certificate[]>;
  listOrders(parent: string): Promise<RenewalOrder[]>;
  listPages(parent: string): Promise<Page[]>;
  orderRenewal(req: { cert: string; parent: string; finding: string; key: string }): Promise<void>;
  pageOwner(req: { owner: string; parent: string; finding: string; reason: string; key: string }): Promise<void>;
}
// #endregion

// #region cert-types
// The loop's own types: what it sees, what can be wrong, and what it can do about it.
interface CertWorld { certs: Certificate[]; orders: RenewalOrder[]; pages: Page[] }
type Expiring = Finding<'expiring', Certificate>;
type CertAction = { key: string; kind: 'renew'; targets: string[]; cert: string; deadlineMs: number };
// #endregion

const RENEW_BEFORE = 14 * DAY;
const daysLeft = (c: Certificate, now: number) => Math.max(0, Math.round((c.expiresAt - now) / DAY));

// #region cert-derive
// #region cert-finding-id
// The expiry is part of the id. Once a certificate is renewed, its next expiry
// is a new finding, with fresh attempts.
const findingId = (c: Certificate) => `expiring:${c.name}@${c.expiresAt}`;
// #endregion

// #region cert-findings
/** What's wrong: every certificate within 14 days of expiry. Worked out fresh on every tick. */
function findingsIn(certs: Certificate[], now: number): Expiring[] {
  return certs
    .filter((c) => c.expiresAt - now < RENEW_BEFORE)
    .map((c) => ({
      id: findingId(c),
      kind: 'expiring',
      severity: 'blocking',
      summary: `${c.name} expires in ${daysLeft(c, now)} days`,
      data: c,
    }));
}
// #endregion

// #region cert-blockers
/** What's already in hand: a pending renewal order, or an open page to the owner. */
function blockersIn(orders: RenewalOrder[], pages: Page[]): Blocker[] {
  const pending = orders.filter((o) => o.status === 'pending').map((o): Blocker => ({
    id: `order:${o.id}`,
    kind: 'order',
    on: [o.finding],   // the finding this order is handling
    scope: 'finding',  // it covers that finding only; it doesn't hold the loop
    summary: `renewal ${o.id} pending`,
    since: o.createdAt,
  }));
  const paged = pages.filter((p) => p.status === 'open').map((p): Blocker => ({
    id: `page:${p.id}`, kind: 'page', on: [p.finding], scope: 'finding',
    summary: 'owner paged', since: p.openedAt,
  }));
  return [...pending, ...paged];
}
// #endregion
// #endregion

// #region cert-spec
export function certRenewalSpec(acts: CertActivities, input: { fleet: string }): ReconcilerSpec<CertWorld, Expiring, CertAction> {
  const self = `certs:${input.fleet}`;
  return {
    name: self,
    budget: { maxAttemptsPerFinding: 3, maxFindingAgeMs: 7 * DAY, retentionMs: 30 * DAY },

    // #region cert-observe
    // Read the world, then work out findings and blockers. Nothing here is remembered.
    async observe({ now }) {
      const [certs, orders, pages] = await Promise.all([
        acts.listCertificates(),
        acts.listOrders(self),
        acts.listPages(self),
      ]);
      return {
        world: { certs, orders, pages },
        findings: findingsIn(certs, now),
        blockers: blockersIn(orders, pages),
      };
    },
    // #endregion

    // #region cert-plan
    // Pure: decide from this frame alone. Open findings are the ones nobody is handling.
    plan(f) {
      const actions = f.open.map((x): CertAction => {
        const attempt = (f.attempts[x.id] ?? 0) + 1;
        return {
          key: `renew:${x.id}:${attempt}`, // a retry gets a new key
          kind: 'renew',
          targets: [x.id],                 // counts as an attempt on the finding
          cert: x.data.name,
          deadlineMs: HOUR,                // claimed until the order shows up, or presumed lost
        };
      });
      return { actions, wake: { afterMs: 6 * HOUR } };
    },
    // #endregion

    // #region cert-act
    // One effect per action, passing the key so the destination can ignore a repeat.
    // `escalate` is the loop's own action, for a finding out of attempts or too old.
    async act(a, f) {
      const key = `${self}/${a.key}`;
      if (a.kind === 'renew') {
        await acts.orderRenewal({ cert: a.cert, finding: a.targets[0]!, parent: self, key });
      }
      if (a.kind === 'escalate') {
        const { owner } = f.findings.find((x) => x.id === a.finding)!.data;
        await acts.pageOwner({ owner, finding: a.finding, reason: a.reason, parent: self, key });
      }
    },
    // #endregion
  };
}
// #endregion

// #region cert-workflow
/** The workflow: run the loop, carrying its memory across checkpoints. In Temporal, a checkpoint is continue-as-new. */
export async function certRenewalWorkflow(rt: Runtime, acts: CertActivities, input: { fleet: string; memory?: LoopMemory }, opts: RunOptions = {}) {
  const out = await reconcileToEnd(rt, certRenewalSpec(acts, input), { maxTicksPerRun: 200, memory: input.memory, ...opts });
  return { status: out.status, reason: out.reason };
}
// #endregion
