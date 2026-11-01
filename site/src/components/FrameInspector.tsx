import { fmt } from '../../../src/runtime/sim';
import type { Lane, Tick } from '../sims/trace';

interface Props { lane?: Lane; tick?: Tick; onStep: (delta: number) => void }

const COLUMNS = [
  { key: 'open', label: 'Open', hint: 'nobody is handling it, so the plan acts on it' },
  { key: 'blocked', label: 'Blocked', hint: 'an obligation in the world (bug, deploy) is handling it' },
  { key: 'claimed', label: 'Claimed', hint: 'an intent is in flight but not visible in the world yet' },
] as const;

/** Plan notes carry raw milliseconds; show them as e.g. "1d 18h". */
const duration = (ms: number) => {
  const d = Math.floor(ms / 86_400_000), h = Math.round((ms % 86_400_000) / 3_600_000);
  return d ? `${d}d ${h}h` : `${h}h`;
};

export function FrameInspector({ lane, tick, onStep }: Props) {
  if (!lane) return <div className="empty">Pick a lane.</div>;
  const total = lane.ticks.length;
  return (
    <div className="inspector">
      <div className="inspector-head">
        <div>
          <div className="mono strong">{lane.wf}</div>
          <div className="muted small">
            {tick ? <>tick {tick.idx + 1} of {total} · {fmt(tick.at)} · woke: <span className="mono">{tick.woke ?? '—'}</span></> : 'no tick yet at this time'}
          </div>
        </div>
        <div className="stepper">
          <button onClick={() => onStep(-1)} disabled={!tick || tick.idx === 0} aria-label="Previous tick">‹</button>
          <button onClick={() => onStep(1)} disabled={!!tick && tick.idx >= total - 1} aria-label="Next tick">›</button>
        </div>
      </div>

      {tick && (
        <>
          <div className="badges">
            {tick.held ? <span className="badge held">held: forward progress waits</span> : <span className="badge clean">not held</span>}
            {tick.acted.length ? <span className="badge acted">acted ×{tick.acted.length}</span> : <span className="badge">idle poll</span>}
            {tick.escalating?.length > 0 && <span className="badge escalating">escalating {tick.escalating.join(', ')}</span>}
            {tick.stalled?.length > 0 && <span className="badge escalating">repeating itself: {tick.stalled.join(', ')}</span>}
            {tick.findings.length === 0 && (tick.blockers.length === 0
              ? <span className="badge clean">clean frame: progress allowed</span>
              : <span className="badge">no findings, but blockers remain</span>)}
          </div>

          <div className="partition">
            {COLUMNS.map((c) => (
              <div key={c.key} className={`part ${c.key}`}>
                <div className="part-title">{c.label} <span className="count">{tick[c.key].length}</span></div>
                <div className="part-hint">{c.hint}</div>
                <div className="chips">
                  {tick[c.key].length ? tick[c.key].map((id) => <span key={id} className={`chip ${c.key}`}>{id}</span>) : <span className="none">none</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="kv">
            <div className="k">Blockers observed</div>
            <div className="chips">
              {tick.blockers.length ? tick.blockers.map((b) => <span key={b} className="chip blocker">{b}</span>) : <span className="none">none</span>}
            </div>
            <div className="k">Intents issued</div>
            <div className="chips">
              {tick.acted.length ? tick.acted.map((k) => <span key={k} className="chip acted">{k}</span>) : <span className="none">none</span>}
            </div>
            {tick.skipped.length > 0 && (
              <>
                <div className="k">Skipped (already in ledger)</div>
                <div className="chips">{tick.skipped.map((k) => <span key={k} className="chip skipped">{k}</span>)}</div>
              </>
            )}
            {tick.note && (
              <>
                <div className="k">Plan note</div>
                <div className="note mono">{tick.note.replace(/\b\d{6,}\b/g, (ms) => duration(Number(ms)))}</div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
