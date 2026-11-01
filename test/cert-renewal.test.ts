import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, DAY, HOUR } from '../src/runtime/sim.js';
import { buildFrame, newMemory } from '../src/core/reconcile.js';
import { certRenewalSpec, certRenewalWorkflow, type CertActivities, type Certificate, type Page, type RenewalOrder } from '../examples/cert-renewal.js';

/**
 * A fake certificate authority and pager. Orders take two hours to issue. `failing` certificates
 * fail every order; `lostOnce` drops the first order on the floor, as if the request never arrived.
 */
class FakeCa {
  certs = new Map<string, Certificate>();
  orders: RenewalOrder[] = [];
  pages: Page[] = [];
  private keys = new Set<string>();
  constructor(private sim: Sim, certs: Certificate[], private failing: string[] = [], private lostOnce: string[] = []) {
    for (const c of certs) this.certs.set(c.name, { ...c });
  }
  activities(): CertActivities {
    return {
      listCertificates: async () => [...this.certs.values()].map((c) => ({ ...c })),
      listOrders: async (parent) => this.orders.filter((o) => o.parent === parent).map((o) => ({ ...o })),
      listPages: async (parent) => this.pages.filter((p) => p.parent === parent).map((p) => ({ ...p })),
      orderRenewal: async ({ cert, parent, finding, key }) => {
        if (this.keys.has(key)) return;
        this.keys.add(key);
        if (this.lostOnce.includes(cert)) { this.lostOnce = this.lostOnce.filter((c) => c !== cert); return; }
        const order: RenewalOrder = { id: `O-${this.orders.length + 1}`, key, parent, finding, status: 'pending', createdAt: this.sim.now };
        this.orders.push(order);
        this.sim.timer(2 * HOUR, () => {
          if (this.failing.includes(cert)) { order.status = 'failed'; return; }
          order.status = 'issued';
          this.certs.get(cert)!.expiresAt = this.sim.now + 90 * DAY;
        });
      },
      pageOwner: async ({ parent, finding, key }) => {
        if (this.keys.has(key)) return;
        this.keys.add(key);
        this.pages.push({ id: `P-${this.pages.length + 1}`, key, parent, finding, status: 'open', openedAt: this.sim.now });
      },
    };
  }
}

// #region cert-test
test('renews what is expiring, retries a lost order, and pages the owner of one that never renews', async () => {
  const sim = new Sim();
  const ca = new FakeCa(sim, [
    { name: 'api', owner: 'platform', expiresAt: 10 * DAY },   // expiring: renew it
    { name: 'www', owner: 'web', expiresAt: 12 * DAY },        // its first order is lost: order again
    { name: 'legacy', owner: 'infra', expiresAt: 5 * DAY },    // every order fails: page the owner
    { name: 'docs', owner: 'web', expiresAt: 80 * DAY },       // not expiring yet
  ], ['legacy'], ['www']);
  sim.register('certs', (rt, input: any) => certRenewalWorkflow(rt, rt.activities(ca.activities()), input));
  sim.start('certs:web-fleet', 'certs', { fleet: 'web-fleet' });
  await sim.run({ until: () => sim.now >= 3 * DAY }); // it never finishes on its own: watch three days

  assert.ok(ca.certs.get('api')!.expiresAt > 90 * DAY, 'api renewed');
  assert.ok(ca.certs.get('www')!.expiresAt > 90 * DAY, 'www renewed after its lost order');
  assert.equal(ca.certs.get('docs')!.expiresAt, 80 * DAY, 'docs left alone');
  // The lost order was presumed lost after its deadline and placed again, as attempt 2.
  assert.deepEqual(ca.orders.filter((o) => o.finding.startsWith('expiring:www')).map((o) => o.key.split(':').at(-1)), ['2']);
  // legacy: three failed orders, then one page to its owner, which holds the finding while it's open.
  assert.equal(ca.orders.filter((o) => o.finding.startsWith('expiring:legacy')).length, 3);
  assert.deepEqual(ca.pages.map((p) => p.finding), [`expiring:legacy@${5 * DAY}`]);
});
// #endregion

// #region cert-plan-test
test('plan is pure: one renewal per open finding, keyed by its attempt number', () => {
  const spec = certRenewalSpec({} as CertActivities, { fleet: 'web-fleet' });
  const api: Certificate = { name: 'api', owner: 'platform', expiresAt: 10 * DAY };
  const finding = { id: `expiring:api@${10 * DAY}`, kind: 'expiring' as const, severity: 'blocking' as const, summary: '', data: api };
  const frame = buildFrame({ world: { certs: [api], orders: [], pages: [] }, findings: [finding], blockers: [] }, newMemory(0), 0, spec.budget);
  assert.deepEqual(spec.plan(frame).actions.map((a) => a.key), [`renew:expiring:api@${10 * DAY}:1`]);
});
// #endregion
