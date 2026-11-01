/** Widgets that drive the real core: buildFrame and escalation from src/core/reconcile.ts. */
import { useState } from 'react';
import { buildFrame, escalation, newMemory } from '../../../src/core/reconcile';
import type { Blocker, Budget, Finding, IntentRecord } from '../../../src/core/types';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const breach: Finding = { id: 'regression:s2', kind: 'regression', severity: 'blocking', summary: 'latency p99 and CPU over threshold', data: {} };
const BUDGET: Budget = { maxAttemptsPerFinding: 3, maxFindingAgeMs: 7 * DAY, escalationDeadlineMs: HOUR };

const GROUP_TEXT = {
  open: 'Nothing is handling it. The plan acts on it this tick.',
  claimed: 'The loop acted and the world hasn\'t caught up yet. The plan leaves it alone.',
  blocked: 'Something in the world is handling it. The plan leaves it alone.',
  escalating: 'The loop hands it to a person this tick.',
} as const;

function groupOf(f: ReturnType<typeof buildFrame>) {
  if (f.escalating.length) return 'escalating' as const;
  if (f.blocked.length) return 'blocked' as const;
  if (f.claimed.length) return 'claimed' as const;
  return 'open' as const;
}

/** Toggle a blocker and an action in flight; the real buildFrame sorts the finding. */
export function SortFinding() {
  const [blocker, setBlocker] = useState(false);
  const [acted, setActed] = useState(true);
  const [minutes, setMinutes] = useState(10);
  const deadline = 60;
  const mem = newMemory(0);
  const now = 2 * HOUR;
  if (acted) mem.intents.push({ key: 'fix:regression:s2:1', kind: 'submit-fix', targets: [breach.id], at: now - minutes * MIN, tick: 0, deadlineMs: deadline * MIN, settled: false });
  const blockers: Blocker[] = blocker ? [{ id: 'deploy:cl/77', kind: 'deploy', on: [breach.id], scope: 'loop', summary: 'fix rolling out' }] : [];
  const frame = buildFrame({ world: {}, findings: [breach], blockers }, mem, now, {});
  const g = groupOf(frame);
  const q1 = blocker, q2 = !blocker && acted && minutes <= deadline;
  return (
    <div className="w">
      <div className="w-title">Sort a finding</div>
      <div className="w-controls">
        <label className="check"><input type="checkbox" checked={blocker} onChange={(e) => setBlocker(e.target.checked)} /> The deploy system lists a fix CL labeled with this finding</label>
        <label className="check"><input type="checkbox" checked={acted} onChange={(e) => setActed(e.target.checked)} /> The ledger has <code>fix:regression:s2:1</code></label>
        {acted && (
          <label className="range">Submitted {minutes} min ago (deadline {deadline} min)
            <input type="range" min={0} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </label>
        )}
      </div>
      <ol className="w-steps">
        <li className={q1 ? 'yes' : 'no'}>Does a blocker in the world name it? <b>{q1 ? 'Yes → blocked' : 'No'}</b></li>
        {!q1 && <li className={q2 ? 'yes' : 'no'}>Is there an action in the ledger, not yet seen, within its deadline? <b>{q2 ? 'Yes → claimed' : acted && minutes > deadline ? 'It passed its deadline: presumed lost' : 'No'}</b></li>}
        {!q1 && !q2 && <li className="yes">Otherwise → <b>open</b></li>}
      </ol>
      <div className={`w-result ${g}`}><b>{g}</b> {GROUP_TEXT[g]}</div>
      <div className="w-foot">Computed by the real <code>buildFrame</code> from <code>src/core/reconcile.ts</code>.</div>
    </div>
  );
}

/** Fixes that don't work: attempts count up, the finding is escalated, a person answers. */
export function Attempts() {
  const [log, setLog] = useState<{ kind: 'fix' | 'escalate'; settled: boolean }[]>([]);
  const mem = newMemory(0);
  mem.intents = log.map((e, i): IntentRecord => ({
    key: `${e.kind}:${breach.id}:${i + 1}`, kind: e.kind === 'fix' ? 'submit-fix' : 'escalate', targets: [breach.id],
    at: (i + 1) * HOUR, tick: i, deadlineMs: HOUR, settled: e.settled, handedOff: e.settled,
  }));
  const now = (log.length + 1) * HOUR;
  const withPerson = log.some((e) => e.kind === 'escalate' && !e.settled);
  const frame = buildFrame({ world: {}, findings: [breach], blockers: withPerson ? [{ id: 'issue:I-1', kind: 'issue', on: [breach.id], scope: 'loop', summary: 'assigned to a person' }] : [] }, mem, now, BUDGET);
  const esc = frame.escalating[0];
  const next = (frame.attempts[breach.id] ?? 0) + 1;
  const sinceEsc = (() => { const i = log.map((e) => e.kind).lastIndexOf('escalate'); return log.slice(i + 1).filter((e) => e.kind === 'fix').length; })();
  return (
    <div className="w">
      <div className="w-title">Three strikes, then a person</div>
      <div className="w-meter">
        {[0, 1, 2].map((i) => <span key={i} className={`pip ${i < sinceEsc ? 'used' : ''}`} />)}
        <span className="muted small">{sinceEsc} of 3 attempts used since the last escalation</span>
      </div>
      <div className="w-log">
        {log.length === 0 && <span className="muted">Latency is regressed. Nothing has been tried yet.</span>}
        {mem.intents.map((it) => <code key={it.key} className={it.kind === 'escalate' ? 'esc' : ''}>{it.key}</code>)}
      </div>
      <div className={`w-result ${esc ? 'escalating' : withPerson ? 'blocked' : 'open'}`}>
        {esc ? <>Escalating: <b>{esc.reason}</b>. The loop files <code>{escalation(esc, frame, BUDGET).key}</code>.</>
          : withPerson ? <>With a person. The finding is <b>blocked</b> until they're done.</>
          : <>Open. The next fix gets the key <code>fix:{breach.id}:{next}</code>.</>}
      </div>
      <div className="w-buttons">
        <button disabled={!!esc || withPerson} onClick={() => setLog([...log, { kind: 'fix', settled: true }])}>Submit a fix (it doesn't work)</button>
        <button disabled={!esc} onClick={() => setLog([...log, { kind: 'escalate', settled: false }])}>Run the tick: escalate</button>
        <button disabled={!withPerson} onClick={() => setLog(log.map((e) => (e.kind === 'escalate' ? { ...e, settled: true } : e)))}>Person closes the issue (still broken)</button>
        <button className="link" onClick={() => setLog([])}>reset</button>
      </div>
      <div className="w-foot">Attempts, keys and escalation reasons come from the real <code>buildFrame</code> and <code>escalation</code>.</div>
    </div>
  );
}

/** The three reasons to escalate, and prerequisites that don't age. */
export function Escalation() {
  const [attempts, setAttempts] = useState(1);
  const [days, setDays] = useState(2);
  const [blocker, setBlocker] = useState<'none' | 'owned' | 'prerequisite'>('none');
  const [repeat, setRepeat] = useState(false);
  const now = 20 * DAY;
  const mem = newMemory(0);
  for (let i = 0; i < attempts; i++)
    mem.intents.push({ key: `fix:${breach.id}:${i + 1}`, kind: 'submit-fix', targets: [breach.id], at: now - days * DAY + i * HOUR, tick: i, deadlineMs: HOUR, settled: true, handedOff: true });
  const blockers: Blocker[] = blocker === 'none' ? [] : [{
    id: blocker === 'owned' ? 'issue:I-4' : 'needs:pricing-svc', kind: blocker, on: [breach.id], scope: 'finding',
    summary: blocker, since: now - days * DAY, prerequisite: blocker === 'prerequisite' || undefined,
  }];
  const frame = buildFrame({ world: {}, findings: [breach], blockers }, mem, now, BUDGET);
  const reason = frame.escalating[0]?.reason ?? (repeat && frame.open.length ? 'the plan only repeats actions already taken' : undefined);
  return (
    <div className="w">
      <div className="w-title">When does a finding go to a person?</div>
      <div className="w-controls grid2">
        <label className="range">Attempts so far: <b>{attempts}</b><input type="range" min={0} max={4} value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} /></label>
        <label className="range">Days since work began: <b>{days}</b><input type="range" min={0} max={12} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
        <label className="field">Covered by
          <select value={blocker} onChange={(e) => setBlocker(e.target.value as typeof blocker)}>
            <option value="none">nothing (open)</option>
            <option value="owned">an issue someone owns</option>
            <option value="prerequisite">a prerequisite (waits for another fix)</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> The plan proposed only keys already in the ledger</label>
      </div>
      <div className={`w-result ${reason ? 'escalating' : frame.blocked.length ? 'blocked' : 'open'}`}>
        {reason ? <>Escalate: <b>{reason}</b>.</> : frame.blocked.length ? <>Blocked, and not escalated{blocker === 'prerequisite' ? ': waiting on a prerequisite never counts toward age' : ''}.</> : <>Open, and the agent keeps trying.</>}
      </div>
      <div className="w-foot">Budget: 3 attempts, 7-day age limit. Out of attempts only applies to open findings. Too old applies to open and blocked ones.</div>
    </div>
  );
}

/** A fix that takes a while to show up in the world. */
export function Deadline() {
  const [lag, setLag] = useState(40);
  const [deadline, setDeadline] = useState(60);
  const reopened = lag > deadline;
  const W = 520, scale = (m: number) => 20 + (m / 180) * (W - 40);
  return (
    <div className="w">
      <div className="w-title">The gap the ledger covers</div>
      <div className="w-controls grid2">
        <label className="range">The deploy system lists the fix after <b>{lag} min</b><input type="range" min={5} max={170} value={lag} onChange={(e) => setLag(Number(e.target.value))} /></label>
        <label className="range">Deadline: <b>{deadline} min</b><input type="range" min={10} max={170} value={deadline} onChange={(e) => setDeadline(Number(e.target.value))} /></label>
      </div>
      <svg viewBox={`0 0 ${W} 92`} className="w-svg">
        <line x1={20} x2={W - 20} y1={46} y2={46} className="axis" />
        <rect x={scale(0)} y={36} width={scale(Math.min(lag, deadline)) - scale(0)} height={20} className="seg claimed" />
        {reopened ? <rect x={scale(deadline)} y={36} width={scale(lag) - scale(deadline)} height={20} className="seg open" />
          : null}
        <rect x={scale(lag)} y={36} width={scale(180) - scale(lag)} height={20} className="seg blocked" />
        <line x1={scale(deadline)} x2={scale(deadline)} y1={26} y2={66} className="marker" />
        <text x={scale(deadline)} y={20} textAnchor="middle" className="lbl">deadline</text>
        <text x={scale(0)} y={82} className="lbl">fix submitted</text>
        <text x={scale(lag)} y={82} textAnchor="middle" className="lbl">fix appears</text>
      </svg>
      <div className="w-legend"><span className="sw claimed" />claimed <span className="sw open" />open again <span className="sw blocked" />blocked by the fix CL</div>
      <div className={`w-result ${reopened ? 'escalating' : 'blocked'}`}>
        {reopened ? <>The deadline passed first. The loop presumed the fix lost and submitted <b>a second fix</b> (<code>fix:regression:s2:2</code>). Set deadlines close to how long an action really takes to show up.</>
          : <>The finding stayed claimed until the fix appeared, then the blocker took over. No duplicate.</>}
      </div>
    </div>
  );
}

/** Blocker scope in a multi-arm experiment: a loop-scoped blocker holds every arm. */
export function Hold() {
  const [bug, setBug] = useState(true);
  const [scope, setScope] = useState<'loop' | 'finding'>('finding');
  const arms = ['A', 'B', 'C'];
  const blocked = (a: string) => bug && (scope === 'loop' || a === 'B');
  return (
    <div className="w">
      <div className="w-title">Holding: the whole loop, or one part of it?</div>
      <div className="w-controls">
        <label className="check"><input type="checkbox" checked={bug} onChange={(e) => setBug(e.target.checked)} /> Arm B has an open bug for its revenue breach</label>
        <div className="segmented" role="group" aria-label="Blocker scope">
          <button className={scope === 'loop' ? 'on' : ''} onClick={() => setScope('loop')}>scope: loop</button>
          <button className={scope === 'finding' ? 'on' : ''} onClick={() => setScope('finding')}>scope: finding (its arm)</button>
        </div>
      </div>
      <div className="arms">
        {arms.map((a) => (
          <div key={a} className={`arm-card ${blocked(a) ? 'held' : 'free'}`}>
            <div className="arm-name">Arm {a}</div>
            <div>{blocked(a) ? 'held: no advance' : 'clean: advances when its soak is up'}</div>
          </div>
        ))}
      </div>
      <div className="w-result note">
        {!bug ? 'No blockers: every arm moves forward on its own clean frame.'
          : scope === 'loop' ? <>The bug <b>holds the loop</b>, so no arm advances until it closes. That's right for a single-treatment ramp: "never advance while something is outstanding".</>
          : <>The bug covers only arm B's finding. A and C keep ramping; B waits. The multi-arm experiment uses this scope.</>}
      </div>
    </div>
  );
}
