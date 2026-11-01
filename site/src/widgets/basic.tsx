/** Concept widgets that step through small scripted stories. */
import { useState } from 'react';

const PHASES = ['Observe', 'Goal met?', 'Decide', 'Act', 'Wait'] as const;

/** One latency regression from start to finish, tick by tick (the guide's "putting it together" table). */
const TICKS = [
  { sees: 'Latency failing at stage 2. No issue, no fix.', group: 'open', does: ['rollback:regression:s2:1 → stage 1', 'fix:regression:s2:1 (submit a fix CL)'], wait: 'looks again at once: it acted' },
  { sees: 'Still failing (metrics lag). The deploy system doesn\'t list the fix yet.', group: 'claimed', does: [], wait: 'checks again in 5 minutes' },
  { sees: 'The deploy system lists the fix CL, labeled with this finding.', group: 'blocked', does: [], wait: 'held; polls hourly' },
  { sees: 'The fix is live and the CL is gone. Fresh metrics aren\'t in yet.', group: 'no finding', does: [], wait: 'waits for readings' },
  { sees: 'All readings pass, and the soak time at stage 1 is up.', group: 'no finding', does: ['advance:1->2@… (clean frame)'], wait: 'polls until the next soak ends' },
] as const;

export function TickCycle() {
  const [tick, setTick] = useState(0);
  const [phase, setPhase] = useState(0);
  const t = TICKS[tick]!;
  const next = () => { if (phase < PHASES.length - 1) setPhase(phase + 1); else if (tick < TICKS.length - 1) { setTick(tick + 1); setPhase(0); } };
  const prev = () => { if (phase > 0) setPhase(phase - 1); else if (tick > 0) { setTick(tick - 1); setPhase(PHASES.length - 1); } };
  const detail = [
    <>Reads the metrics, the bug tracker and the deploy system. <b>{t.sees}</b></>,
    <>The goal is "at 100%, soaked, every guardrail passing". Not yet, so the tick goes on.</>,
    <>The regression finding is <b>{t.group}</b>. {t.does.length ? 'The plan proposes:' : 'The plan proposes nothing for it.'}{t.does.length > 0 && <ul>{t.does.map((d) => <li key={d}><code>{d}</code></li>)}</ul>}</>,
    <>{t.does.length ? 'Runs each action whose key isn\'t in the ledger yet, and records it.' : 'Nothing to do.'}</>,
    <>Then it {t.wait}.</>,
  ];
  return (
    <div className="w">
      <div className="w-title">One tick at a time · tick {tick + 1} of {TICKS.length}</div>
      <div className="phase-row">
        {PHASES.map((p, i) => <span key={p} className={`phase ${i === phase ? 'on' : i < phase ? 'past' : ''}`}>{p}</span>)}
      </div>
      <div className="w-result note">{detail[phase]}</div>
      <div className="w-buttons">
        <button onClick={prev} disabled={tick === 0 && phase === 0}>← Back</button>
        <button className="primary" onClick={next} disabled={tick === TICKS.length - 1 && phase === PHASES.length - 1}>Next step →</button>
        <button className="link" onClick={() => { setTick(0); setPhase(0); }}>restart</button>
      </div>
    </div>
  );
}

const PAIRS = [
  { a: '2:00 pm, stage 2: latency p99 and CPU are failing.', b: '8:00 pm: p99, p50 and CPU are failing, and the error rate has joined.', same: true, ids: ['regression:s2', 'regression:s2'], why: 'Correlated metrics fail for one cause, so they are one regression. The id leaves the metrics out, so a metric joining doesn\'t make it a new problem.' },
  { a: 'Stage 2 regresses; the loop rolls back, a fix lands, and the ramp re-advances to stage 2.', b: 'Back at stage 2, the same regression returns.', same: true, ids: ['regression:s2', 'regression:s2'], why: 'The id is the highest stage reached, so a recurrence keeps its attempts and age, and a problem that keeps coming back is escalated.' },
  { a: 'Stage 2: a latency regression, fixed.', b: 'The ramp reaches stage 3, and CPU regresses.', same: false, ids: ['regression:s2', 'regression:s3'], why: 'A regression at a stage the ramp never reached before is a new finding, with fresh attempts.' },
  { a: 'Reviewer on thread t3, message m3: "why not reuse the cache?"', b: 'The agent replied. Reviewer on t3 again, message m7: "and eviction?"', same: false, ids: ['thread:t3@m3', 'thread:t3@m7'], why: 'A follow-up deserves a fresh response, so the latest message is part of the id.' },
  { a: '//search:server broke on Monday at cl/4004. Reverted; green.', b: '//search:server breaks on Friday at cl/4120.', same: false, ids: ['build:…search:server@cl/4004', 'build:…search:server@cl/4120'], why: 'The first bad CL is in the id, so last week\'s attempts don\'t count against this week\'s breakage.' },
  { a: 'Revision 1: reviewer flags a null dereference at auth.ts:42.', b: 'Revision 2: the same null dereference is still at auth.ts:42.', same: true, ids: ['correctness:auth.ts:42:null-deref', 'correctness:auth.ts:42:null-deref'], why: 'The revision is left out of the id: an unfixed comment is the same finding next round, so its attempts keep counting.' },
  { a: 'Multi-arm experiment: arm B breaks the error rate.', b: 'Arm C breaks the error rate too.', same: false, ids: ['regression:B:s2', 'regression:C:s2'], why: 'Each arm rolls back and holds on its own, so each arm\'s regression is its own finding.' },
];

export function SameFinding() {
  const [i, setI] = useState(0);
  const [guess, setGuess] = useState<boolean>();
  const [score, setScore] = useState(0);
  const p = PAIRS[i]!;
  const answer = (g: boolean) => { if (guess !== undefined) return; setGuess(g); if (g === p.same) setScore(score + 1); };
  return (
    <div className="w">
      <div className="w-title">Same finding, or a new one? · {i + 1} of {PAIRS.length} · score {score}</div>
      <div className="pair">
        <div className="obs">{p.a}</div>
        <div className="obs">{p.b}</div>
      </div>
      <div className="w-buttons">
        <button className={guess === true ? (p.same ? 'right' : 'wrong') : ''} onClick={() => answer(true)}>Same finding</button>
        <button className={guess === false ? (!p.same ? 'right' : 'wrong') : ''} onClick={() => answer(false)}>New finding</button>
      </div>
      {guess !== undefined && (
        <div className={`w-result ${guess === p.same ? 'blocked-ok' : 'escalating'}`}>
          <b>{guess === p.same ? 'Right.' : 'Not quite.'}</b> <code>{p.ids[0]}</code>{p.same ? ' both times. ' : <> then <code>{p.ids[1]}</code>. </>}{p.why}
          <div className="w-buttons">{i < PAIRS.length - 1 ? <button className="primary" onClick={() => { setI(i + 1); setGuess(undefined); }}>Next pair →</button>
            : <button onClick={() => { setI(0); setGuess(undefined); setScore(0); }}>Play again</button>}</div>
        </div>
      )}
    </div>
  );
}

/** Keys with and without attempt numbers: a retry under a spent key never runs. */
export function Keys() {
  const [withAttempt, setWithAttempt] = useState(true);
  const [ledger, setLedger] = useState<string[]>([]);
  const [log, setLog] = useState<{ key: string; ran: boolean }[]>([]);
  const key = withAttempt ? `fix:regression:s2:${log.filter((l) => l.ran).length + 1}` : 'fix:regression:s2';
  const propose = () => {
    const ran = !ledger.includes(key);
    if (ran) setLedger([...ledger, key]);
    setLog([...log, { key, ran }]);
  };
  const reset = (v: boolean) => { setWithAttempt(v); setLedger([]); setLog([]); };
  const stuck = log.length > 0 && !log.at(-1)!.ran;
  return (
    <div className="w">
      <div className="w-title">Keys: each one happens at most once</div>
      <div className="segmented" role="group" aria-label="Key format">
        <button className={withAttempt ? 'on' : ''} onClick={() => reset(true)}>with attempt number</button>
        <button className={!withAttempt ? 'on' : ''} onClick={() => reset(false)}>without</button>
      </div>
      <p className="muted small">The fix lands, and latency is still regressed. The plan proposes a retry. Next key: <code>{key}</code></p>
      <div className="w-buttons"><button className="primary" onClick={propose} disabled={log.length >= 4}>{log.length ? 'Fix didn\'t work: propose a retry' : 'Propose the first fix'}</button></div>
      <div className="w-log">
        {log.map((l, j) => <div key={j} className={l.ran ? 'ran' : 'skipped'}><code>{l.key}</code> {l.ran ? 'runs, and goes in the ledger' : 'skipped: already in the ledger'}</div>)}
      </div>
      {stuck && <div className="w-result escalating">The retry was skipped, so nothing happens. The loop notices the plan is <b>repeating itself</b>, escalates the finding, and logs an error: a key is missing its attempt number.</div>}
      {!stuck && log.length >= 2 && <div className="w-result blocked-ok">Every retry has a fresh key, so each one runs, and the attempts count up toward the limit of 3.</div>}
    </div>
  );
}

/** A rollback hides a regression while its fix is still rolling out. */
const STORY = [
  { t: 'Stage 2: latency regresses.', finding: true, cl: false, rolled: false },
  { t: 'The loop rolls back to stage 1 and submits a fix CL.', finding: true, cl: true, rolled: true },
  { t: 'At stage 1 traffic is too low to show the regression. The finding disappears.', finding: false, cl: true, rolled: true },
  { t: 'The fix lands in prod. The CL is no longer rolling out.', finding: false, cl: false, rolled: true },
] as const;

export function BlockerVsStatus() {
  const [i, setI] = useState(0);
  const s = STORY[i]!;
  const statusModelAdvances = !s.finding && i >= 2;
  const blockerModelAdvances = !s.finding && !s.cl;
  return (
    <div className="w">
      <div className="w-title">Why "being handled" lives in the world, not on the finding</div>
      <div className="story-step">Step {i + 1} of {STORY.length}: {s.t}</div>
      <div className="contrast">
        <div className={`contrast-card ${statusModelAdvances && s.cl ? 'bad' : ''}`}>
          <div className="contrast-title">"Status" on the finding</div>
          <p>{s.finding ? 'Finding: being handled.' : 'The finding is gone, and its status went with it.'}</p>
          <p><b>{statusModelAdvances ? (s.cl ? 'Advances to stage 2 while the fix is still rolling out!' : 'Advances.') : 'Waits.'}</b></p>
        </div>
        <div className="contrast-card good">
          <div className="contrast-title">A blocker in the world</div>
          <p>{s.cl ? 'Blocker deploy:cl/77 is in the deploy system, labeled with the finding.' : 'No blocker.'}</p>
          <p><b>{blockerModelAdvances ? 'Clean frame: advances.' : 'Held: waits.'}</b></p>
        </div>
      </div>
      <div className="w-buttons">
        <button onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0}>← Back</button>
        <button className="primary" onClick={() => setI(Math.min(STORY.length - 1, i + 1))} disabled={i === STORY.length - 1}>Next →</button>
      </div>
    </div>
  );
}

const ENDINGS = [
  { id: 'goal', label: 'The ramp reaches 100% and soaks', ends: 'Goal met', text: 'done() returns a reason. The loop returns done. It is checked first, so a loop that succeeded on its last day still reports success.' },
  { id: 'time', label: '60 days pass with a breach that never clears', ends: 'Out of time', text: 'Only finite loops have a time budget. The workflow puts the experiment in a safe hold: back to stage 0, and a person takes over.' },
  { id: 'stop', label: 'The plan says stop', ends: 'Told to stop', text: 'The plan returns halt, after its actions run, so a safety rollback in the same plan still happens. Then the safe hold.' },
  { id: 'stuck', label: 'One finding is out of attempts', ends: 'Not an ending', text: 'It is escalated: an issue assigned to a person blocks that finding, and the loop carries on with everything else.' },
  { id: 'forever', label: 'An on-call agent runs for a year', ends: 'Not an ending', text: 'No goal and no time budget: it runs until someone cancels it. Retention keeps its memory bounded.' },
];

export function Endings() {
  const [sel, setSel] = useState(ENDINGS[0]!.id);
  const e = ENDINGS.find((x) => x.id === sel)!;
  return (
    <div className="w">
      <div className="w-title">What ends a loop?</div>
      <div className="choice-list">
        {ENDINGS.map((x) => <button key={x.id} className={x.id === sel ? 'on' : ''} onClick={() => setSel(x.id)}>{x.label}</button>)}
      </div>
      <div className={`w-result ${e.ends === 'Not an ending' ? 'blocked-ok' : e.id === 'goal' ? 'blocked-ok' : 'escalating'}`}><b>{e.ends}.</b> {e.text}</div>
    </div>
  );
}
