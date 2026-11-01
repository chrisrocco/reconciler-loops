import { useEffect, useState } from 'react';
import { Sim, HOUR } from '../../../../src/runtime/sim';
import { reconcileToEnd } from '../../../../src/core/reconcile';
import { BOT, codeReviewSpec, type CLView } from '../../../../src/scenarios/code-review';
import { FakeCodeReview } from '../../../../src/fakes/review-world';
import { Recorder, type TraceRun } from '../trace';
import { SimShell, type Variant } from '../../components/SimShell';
import { TracePlayer } from '../../components/TracePlayer';

const WF = 'code-review:cl/100';

const VARIANTS: Variant[] = [
  { id: 'typical', title: 'Two days of review', blurb: 'A reviewer leaves a nit, a bug, a question, a follow-up, a design concern and some praise. The agent classifies each once, fixes the nit and bug in one revision, drafts answers for the owner, escalates the design question, and submits once approved.' },
  { id: 'late', title: 'Started late', blurb: 'The loop starts a day and a half in, with every comment already there. Because it is level-triggered, it reaches the same result as if it had been running all along.' },
  { id: 'lost-drafts', title: 'Lost drafts', blurb: 'The review system accepts the draft replies but never shows them. Each lost draft is retried under a new key until the agent is out of attempts, then the thread is escalated to the CL owner.' },
];

async function run(variant: string): Promise<TraceRun<CLView>> {
  const sim = new Sim();
  const cr = new FakeCodeReview(sim, WF);
  cr.loseDrafts = variant === 'lost-drafts';
  const rec = new Recorder(sim, () => cr.cl);
  sim.register('code-review', rec.tracked((rt) =>
    reconcileToEnd(rt, codeReviewSpec(rt.activities(cr.activities()), { clId: 'cl/100' }), { maxTicksPerRun: 20, onTick: rec.onTick(rt.workflowId) })));
  if (variant === 'lost-drafts') {
    sim.at(HOUR, () => cr.comment('alice', 'q: why not reuse the existing cache?'));
  } else {
    sim.at(1 * HOUR, () => {
      cr.comment('alice', 'nit: rename tmp to buffer');
      cr.comment('alice', 'bug: missing null check on user');
      cr.comment('alice', 'q: why not reuse the existing cache?');
    });
    sim.at(8 * HOUR, () => cr.comment('alice', 'q: and what about eviction under memory pressure?', 't3'));
    sim.at(9 * HOUR, () => {
      cr.comment('alice', 'design: should this live in its own service?');
      cr.comment('alice', 'praise: nice test coverage');
    });
    sim.at(30 * HOUR, () => cr.reviewerPass('alice'));
    sim.at(54 * HOUR, () => cr.reviewerPass('alice'));
  }
  sim.at(variant === 'late' ? 36 * HOUR : 0, () => sim.start(WF, 'code-review', {}));
  return rec.finish(WF, () => 0, { maxMs: 30 * 24 * HOUR });
}

export function CodeReviewSim({ variant }: { variant?: string }) {
  const v = VARIANTS.find((x) => x.id === variant) ?? VARIANTS[0]!;
  const [result, setResult] = useState<{ id: string; run: TraceRun<CLView> }>();
  useEffect(() => { let live = true; run(v.id).then((r) => live && setResult({ id: v.id, run: r })); return () => { live = false; }; }, [v.id]);
  const r = result?.id === v.id ? result.run : undefined;
  return (
    <SimShell sim="code-review" title="Code review" variants={VARIANTS} variant={v} run={r as TraceRun<unknown>}
      intro={<>Unanswered reviewer comments are findings. Drafts waiting on the owner are blockers that cover only their own thread.</>}>
      {r && <TracePlayer run={r} worldTitle="The CL" world={(cl) => <ClView cl={cl} />} seconds={20} />}
    </SimShell>
  );
}

function ClView({ cl }: { cl: CLView }) {
  return (
    <div className="cl-view">
      <div className="cl-meta">
        <span className="mono">{cl.id}</span> · owner <b>{cl.owner}</b> · revision {cl.revision}
        {cl.approvals.length > 0 && <span className="tag good">approved by {cl.approvals.join(', ')}</span>}
        {cl.submitted && <span className="tag good">submitted</span>}
      </div>
      {cl.threads.length === 0 && <div className="empty">No comments yet.</div>}
      <div className="threads">
        {cl.threads.map((t) => (
          <div key={t.id} className={`thread ${t.resolved ? 'resolved' : ''}`}>
            <div className="thread-head">
              <span className="mono">{t.id}</span>
              {t.resolved ? <span className="tag">resolved</span> : <span className="tag warn">open</span>}
              {t.labels.includes('needs-owner') && <span className="tag bad">escalated to owner</span>}
            </div>
            {t.messages.map((m) => (
              <div key={m.id} className={`msg ${m.author === BOT ? 'bot' : m.author === cl.owner ? 'owner' : 'reviewer'} ${m.draft ? 'draft' : ''}`}>
                <span className="msg-author">{m.author === BOT ? 'agent' : m.author}{m.draft ? ' (draft, awaiting owner)' : ''}</span>
                <span className="msg-body">{m.body}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
