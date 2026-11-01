import { useEffect, useState } from 'react';
import { Sim, DAY, HOUR, fmt } from '../../../../src/runtime/sim';
import { reconcileToEnd } from '../../../../src/core/reconcile';
import { AGENT, codeReviewLoop, type ChangeView } from '../../../../src/scenarios/code-review';
import { LOST_DRAFTS, ReviewSystem, SLOW_REVIEWER, STUCK_CHECK, TYPICAL, VOTES_RESET, type ReviewSystemConfig } from '../../../../src/fakes/review-system';
import { Recorder, type TraceRun } from '../trace';
import { SimShell, type Variant } from '../../components/SimShell';
import { TracePlayer } from '../../components/TracePlayer';

const WF = 'code-review:change/100';

const VARIANTS: (Variant & { cfg: ReviewSystemConfig; startAt?: number })[] = [
  { id: 'typical', cfg: TYPICAL, title: 'A typical review', blurb: 'Two directories and two languages, so three approvals. Alice reviews search/; nobody on the change owns web/, and bob is out, so the agent adds carol. Comments are fixed in one patchset, answered, drafted for the owner, or put to the owner. A flaky check is rerun, the branch moves and the change is rebased, and it is submitted once every requirement is met.' },
  { id: 'late', cfg: TYPICAL, startAt: 30 * HOUR, title: 'Started late', blurb: 'The loop starts 30 hours in, with comments already waiting. It is level-triggered, so it reads where things stand and reaches the same result.' },
  { id: 'slow-reviewer', cfg: SLOW_REVIEWER, title: 'A reviewer who never comes', blurb: 'The web/ owner on the change never takes their turn. The approval counts as covered, so the loop waits, until it has been their turn for two days. Then it tags the owner, who swaps them for someone who responds.' },
  { id: 'votes-reset', cfg: VOTES_RESET, title: 'Votes that reset', blurb: 'This review system clears approvals on a new patchset. Alice approves, then the branch moves with a conflict a rebase can\'t fix. The agent resolves it in code, which clears her approval; the loop waits for her to approve again before submitting.' },
  { id: 'stuck-check', cfg: STUCK_CHECK, title: 'A check that won\'t pass', blurb: 'A required check fails for real whatever the agent changes. After three attempts it tags the owner, who fixes it themselves.' },
  { id: 'lost-drafts', cfg: LOST_DRAFTS, title: 'Lost drafts', blurb: 'The review system accepts the agent\'s draft replies but never shows them. Each is retried under a new key, then the thread goes to the owner.' },
];

async function run(v: (typeof VARIANTS)[number]): Promise<TraceRun<ChangeView>> {
  const sim = new Sim();
  const rs = new ReviewSystem(sim, WF, v.cfg);
  const rec = new Recorder(sim, () => rs.view());
  sim.register('code-review', rec.tracked((rt) =>
    reconcileToEnd(rt, codeReviewLoop(rt.activities(rs.activities()), { change: 'change/100' }), { maxTicksPerRun: 20, onTick: rec.onTick(rt.workflowId) })));
  sim.at(v.startAt ?? 0, () => sim.start(WF, 'code-review', {}));
  return rec.finish(WF, () => 0, { maxMs: 40 * DAY });
}

export function CodeReviewSim({ variant }: { variant?: string }) {
  const v = VARIANTS.find((x) => x.id === variant) ?? VARIANTS[0]!;
  const [result, setResult] = useState<{ id: string; run: TraceRun<ChangeView> }>();
  useEffect(() => { let live = true; run(v).then((r) => live && setResult({ id: v.id, run: r })); return () => { live = false; }; }, [v]);
  const r = result?.id === v.id ? result.run : undefined;
  return (
    <SimShell sim="code-review" title="Code review" variants={VARIANTS} variant={v} run={r as TraceRun<unknown>}
      intro={<>Every submit requirement that isn't met is a finding; whatever is already meeting it is a blocker. So the only forward step is submit.</>}>
      {r && <TracePlayer run={r} worldTitle="The change" world={(c, t) => <ChangePanel c={c} t={t} />} seconds={25} />}
    </SimShell>
  );
}

function ChangePanel({ c, t }: { c: ChangeView; t: number }) {
  const onChange = new Set(c.reviewers.map((r) => r.user));
  return (
    <div className="cl-view">
      <div className="cl-meta">
        <span className="mono">{c.id}</span> · owner <b>{c.owner}</b> · patchset {c.patchset}
        {c.status !== 'open' && <span className="tag good">{c.status}</span>}
        {!c.mergeable.ok && <span className={`tag ${c.mergeable.autoRebase ? 'warn' : 'bad'}`}>{c.mergeable.autoRebase ? 'needs a rebase' : 'merge conflict'}</span>}
        {c.attention.length > 0 && <span className="tag">attention: {c.attention.join(', ')}</span>}
      </div>
      <div className="req-grid">
        <div className="board-col">
          <div className="board-title">Submit requirements</div>
          {c.requirements.map((q) => {
            const by = c.reviewers.filter((r) => q.eligible.includes(r.user) && !r.away).map((r) => r.user);
            return (
              <div key={q.id} className={`board-row ${q.satisfied ? 'good' : by.length ? 'warn' : 'bad'}`}>
                <span className="mono">{q.id}</span>
                <span>{q.satisfied ? 'met' : by.length ? `waiting on ${by.join(', ')}` : 'nobody assigned can grant it'}</span>
              </div>
            );
          })}
          {c.checks.map((k) => (
            <div key={k.name} className={`board-row ${k.state === 'passed' ? 'good' : k.state === 'running' ? 'warn' : 'bad'}`}>
              <span className="mono">check {k.name}</span>
              <span>{k.state}{k.likelyFlaky ? ' (flaky?)' : ''} · ps{k.patchset}{k.runs > 1 ? ` · run ${k.runs}` : ''}</span>
            </div>
          ))}
        </div>
        <div className="board-col">
          <div className="board-title">Reviewers</div>
          {c.reviewers.length === 0 && <div className="empty">none</div>}
          {c.reviewers.map((r) => (
            <div key={r.user} className={`board-row ${r.away ? 'bad' : r.turnSince !== undefined ? 'warn' : ''}`}>
              <span>{r.user}</span>
              <span>{r.away ? 'away' : r.turnSince !== undefined ? `their turn for ${fmt(t - r.turnSince).replace(/^d0\+/, '')}` : 'waiting on the author'}</span>
            </div>
          ))}
          {c.away.filter((u) => !onChange.has(u)).map((u) => <div key={u} className="board-row"><span>{u}</span><span>out of office</span></div>)}
        </div>
      </div>
      <div className="threads">
        {c.threads.map((th) => (
          <div key={th.id} className={`thread ${th.resolved ? 'resolved' : ''}`}>
            <div className="thread-head">
              <span className="mono">{th.id}{th.location ? ` · ${th.location}` : ''}</span>
              {th.origin === 'analyzer' && <span className="tag">analyzer</span>}
              {th.resolved ? <span className="tag">resolved</span> : <span className="tag warn">open</span>}
            </div>
            {th.messages.map((m) => (
              <div key={m.id} className={`msg ${m.author === AGENT ? 'bot' : m.author === c.owner ? 'owner' : 'reviewer'} ${m.draft ? 'draft' : ''}`}>
                <span className="msg-author">{m.author === AGENT ? 'agent' : m.author}{m.draft ? ' (draft, awaiting the owner)' : ''}</span>
                <span className="msg-body">{m.body}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
