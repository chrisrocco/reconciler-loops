import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, HOUR } from '../src/runtime/sim.js';
import { reconcile } from '../src/core/reconcile.js';
import { reviewLoopSpec } from '../src/scenarios/review-loop.js';
import { FakeChange, type PlantedIssue } from '../src/fakes/review-world.js';

const DIMS = ['correctness', 'tests', 'style'];

/** An authoring workflow that calls the review loop INLINE, mid-workflow, then composes on its outcome. */
function run(planted: PlantedIssue[], extra: Partial<Parameters<typeof reviewLoopSpec>[1]> = {}) {
  const sim = new Sim();
  const change = new FakeChange(sim, planted);
  sim.register('author', async (rt) => {
    const acts = rt.activities(change.activities());
    // … the agent wrote the change …
    const out = await reconcile(rt, reviewLoopSpec(acts, { changeId: 'c1', dimensions: DIMS, ...extra }));
    // … and only mails it for human review if the local loop converged.
    return { out, mailed: out.status === 'done' };
  });
  sim.start('author:c1', 'author', {});
  return { sim, change, result: async () => { await sim.run(); return sim.result<any>('author:c1'); } };
}

const issue = (dimension: string, location: string, issue: string, fixAfter = 1, more: Partial<PlantedIssue> = {}): PlantedIssue =>
  ({ dimension, location, issue, severity: 'blocking', detail: `${issue} at ${location}`, fixAfter, ...more });

test('converges: fixes, a regression introduced by a fix, and a two-try fix', async () => {
  const { change, sim, result } = run([
    issue('correctness', 'auth.ts:42', 'null-deref', 1, { introducesOnFix: issue('tests', 'auth.test.ts', 'missing-branch-test') }),
    issue('tests', 'cache.test.ts', 'flaky-timeout', 2),
    issue('style', 'cache.ts:10', 'naming', 1, { severity: 'advisory' }),
  ]);
  const { out, mailed } = await result();
  assert.equal(out.status, 'done');
  assert.equal(out.reason, 'clean at r2');
  assert.ok(mailed);
  assert.equal(change.calls.revise, 2);
  assert.equal(change.calls.review, DIMS.length * 3, 'each dimension reviewed once per revision');
  assert.ok(sim.now < 2 * HOUR);
});

test('advisory-only findings do not block convergence', async () => {
  const { result } = run([issue('style', 'x.ts:1', 'naming', Infinity, { severity: 'advisory' })]);
  const { out } = await result();
  assert.equal(out.status, 'done');
  assert.equal(out.frame.findings.length, 1);
});

test('stubborn finding: escalated after maxAttemptsPerFinding, and the inline loop stops with it', async () => {
  const { result } = run([issue('correctness', 'db.ts:7', 'sql-injection', Infinity), issue('style', 'a.ts', 'naming')]);
  const { out, mailed } = await result();
  assert.equal(out.status, 'escalated');
  assert.equal(out.reason, 'correctness:db.ts:7:sql-injection: still unresolved after 3 attempts');
  assert.equal(out.frame.attempts['correctness:db.ts:7:sql-injection'], 3);
  assert.equal(mailed, false);
});

test('round limit: the plan stops before a slow fix lands', async () => {
  const { result } = run([issue('tests', 't.ts', 'coverage', 5)], { maxRounds: 3, maxAttemptsPerFinding: 10 });
  const { out } = await result();
  assert.equal(out.status, 'escalated');
  assert.equal(out.reason, 'not clean after 3 rounds');
});
