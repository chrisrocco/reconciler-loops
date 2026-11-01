import { useEffect, useState } from 'react';
import { Sim, HOUR } from '../../../../src/runtime/sim';
import { reconcile } from '../../../../src/core/reconcile';
import { reviewLoopSpec, type ReviewComment } from '../../../../src/scenarios/review-loop';
import { FakeChange, type PlantedIssue } from '../../../../src/fakes/review-world';
import { Recorder, type TraceRun } from '../trace';
import { SimShell, type Variant } from '../../components/SimShell';
import { TracePlayer } from '../../components/TracePlayer';

const WF = 'author:c1';
const DIMS = ['correctness', 'tests', 'style'];

const issue = (dimension: string, location: string, name: string, fixAfter = 1, more: Partial<PlantedIssue> = {}): PlantedIssue =>
  ({ dimension, location, issue: name, severity: 'blocking', detail: `${name} at ${location}`, fixAfter, ...more });

const VARIANTS: (Variant & { planted: PlantedIssue[]; opts?: { maxRounds?: number; maxAttemptsPerFinding?: number } })[] = [
  {
    id: 'converges', title: 'Converges', blurb: 'Three reviewers find a null dereference, a flaky test and a naming nit. Fixing the null dereference introduces a missing test, which the next round catches. The loop is clean at revision 2, and the change is mailed.',
    planted: [
      issue('correctness', 'auth.ts:42', 'null-deref', 1, { introducesOnFix: issue('tests', 'auth.test.ts', 'missing-branch-test') }),
      issue('tests', 'cache.test.ts', 'flaky-timeout', 2),
      issue('style', 'cache.ts:10', 'naming', 1, { severity: 'advisory' }),
    ],
  },
  {
    id: 'stubborn', title: 'A stubborn finding', blurb: 'An SQL injection the author agent never manages to fix. After three attempts the finding is escalated. This loop runs inline with nobody to page, so the plan stops and the caller hands the change to a person.',
    planted: [issue('correctness', 'db.ts:7', 'sql-injection', Infinity), issue('style', 'a.ts', 'naming')],
  },
  {
    id: 'rounds', title: 'Out of rounds', blurb: 'A coverage gap that takes five revisions to close, with a three-round limit. The plan stops when the rounds run out.',
    planted: [issue('tests', 't.ts', 'coverage', 5)], opts: { maxRounds: 3, maxAttemptsPerFinding: 10 },
  },
];

interface Snap { revision: number; comments: ReviewComment[] }

async function run(v: (typeof VARIANTS)[number]): Promise<TraceRun<Snap> & { mailed: boolean }> {
  const sim = new Sim();
  const change = new FakeChange(sim, v.planted);
  let comments: ReviewComment[] = [];
  const acts = change.activities();
  const review = acts.review;
  acts.review = async (d, id, rev) => { const r = await review(d, id, rev); comments = [...comments.filter((c) => c.dimension !== d), ...r]; return r; };
  const rec = new Recorder<Snap>(sim, () => ({ revision: change.revision, comments }));
  let mailed = false;
  sim.register('author', rec.tracked(async (rt) => {
    // … the agent wrote the change … then the review loop runs inline, mid-workflow.
    const out = await reconcile(rt, reviewLoopSpec(rt.activities(acts), { changeId: 'c1', dimensions: DIMS, ...v.opts }), { onTick: rec.onTick(rt.workflowId) });
    mailed = out.status === 'done';
    return { status: out.status, reason: 'reason' in out ? out.reason : undefined };
  }));
  sim.start(WF, 'author', {});
  const r = await rec.finish(WF, () => 0, { maxMs: 24 * HOUR });
  return { ...r, mailed };
}

export function ReviewLoopSim({ variant }: { variant?: string }) {
  const v = VARIANTS.find((x) => x.id === variant) ?? VARIANTS[0]!;
  const [result, setResult] = useState<{ id: string; run: Awaited<ReturnType<typeof run>> }>();
  useEffect(() => { let live = true; run(v).then((r) => live && setResult({ id: v.id, run: r })); return () => { live = false; }; }, [v]);
  const r = result?.id === v.id ? result.run : undefined;
  return (
    <SimShell sim="review-loop" title="Inline review loop" variants={VARIANTS} variant={v} run={r as TraceRun<unknown>}
      stats={r ? [{ label: 'mailed', value: r.mailed ? 'yes' : 'no' }] : undefined}
      intro={<>A loop that runs inside a larger workflow for minutes: reviewers' comments are findings, and the author agent addresses all of them in one revision per round.</>}>
      {r && <TracePlayer run={r} worldTitle="Reviewer comments" seconds={12} world={(s) => (
        <div className="review-board">
          <div className="cl-meta">revision {s.revision}</div>
          <div className="review-cols">
            {DIMS.map((d) => {
              const cs = s.comments.filter((c) => c.dimension === d);
              return (
                <div key={d} className="review-col">
                  <div className="review-dim">{d}</div>
                  {cs.length ? cs.map((c) => (
                    <div key={c.location + c.issue} className={`review-comment ${c.severity}`}>
                      <span className="mono">{c.location}</span> {c.issue.replace(/-/g, ' ')}
                      {c.severity === 'advisory' && <span className="tag">advisory</span>}
                    </div>
                  )) : <div className="review-clean">clean</div>}
                </div>
              );
            })}
          </div>
        </div>
      )} />}
    </SimShell>
  );
}
