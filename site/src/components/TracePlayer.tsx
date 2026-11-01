import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fmt } from '../../../src/runtime/sim';
import { usePlayback } from '../hooks';
import { snapshotAt, type Tick, type TraceRun } from '../sims/trace';
import { LaneChart } from './LaneChart';
import { FrameInspector } from './FrameInspector';
import { EventLog } from './EventLog';

interface Props<S> {
  run: TraceRun<S>;
  /** The world as it stood at the playhead. */
  world: (s: S, t: number) => ReactNode;
  worldTitle: string;
  label?: (wf: string) => string;
  /** Seconds of wall-clock time to play the whole run at 1×. */
  seconds?: number;
}

/** Playback for a recorded simulation: transport, loop lanes, the world at the playhead, the frame, the log. */
export function TracePlayer<S>({ run, world, worldTitle, label, seconds = 30 }: Props<S>) {
  const from = 0, to = run.end;
  const [t, setT] = useState(to);
  const [laneId, setLaneId] = useState(run.lanes[0]?.wf);
  const [pinned, setPinned] = useState<number>();
  useEffect(() => { setT(run.end); setLaneId(run.lanes[0]?.wf); setPinned(undefined); }, [run]);

  const seek = useCallback((v: number) => { setT(v); setPinned(undefined); }, []);
  const playback = usePlayback(from, to, t, seek, seconds);
  const lane = run.lanes.find((l) => l.wf === laneId) ?? run.lanes[0];
  const tick: Tick | undefined = useMemo(() => {
    if (!lane) return undefined;
    if (pinned !== undefined) return lane.ticks[pinned];
    let last: Tick | undefined;
    for (const k of lane.ticks) { if (k.at > t) break; last = k; }
    return last;
  }, [lane, pinned, t]);
  const selectTick = (k: Tick) => { playback.setPlaying(false); setLaneId(k.wf); setT(k.at); setPinned(k.idx); };
  const step = (d: number) => { const next = lane?.ticks[Math.max(0, Math.min(lane.ticks.length - 1, (tick?.idx ?? -1) + d))]; if (next) selectTick(next); };
  const snap = snapshotAt(run.snapshots, t);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea, button')) return;
      if (e.key === ' ') { e.preventDefault(); playback.toggle(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <section className="panel">
        <div className="transport">
          <button className="play" onClick={playback.toggle}>{playback.playing ? 'Pause' : t >= to ? 'Replay' : 'Play'}</button>
          <input className="scrub" type="range" min={from} max={to} step={(to - from) / 2000 || 1} value={Math.min(to, Math.max(from, t))}
            onChange={(e) => { playback.setPlaying(false); seek(Number(e.target.value)); }} aria-label="Simulation time" />
          <span className="clock mono">{fmt(t)} <span className="muted">/ {fmt(run.end)}</span></span>
          <select value={playback.speed} onChange={(e) => playback.setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {[0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
        <LaneChart lanes={run.lanes} from={from} to={to} t={t} selectedLane={lane?.wf} selectedTick={tick} label={label}
          onSeek={(v) => { playback.setPlaying(false); seek(v); }} onSelectTick={selectTick} onSelectLane={(wf) => { setLaneId(wf); setPinned(undefined); }} />
        <div className="legend">
          <span><i className="lg dot idle" /> idle poll</span>
          <span><i className="lg dot acted" /> tick that acted</span>
          <span><i className="lg dot signal" /> woken early by a hint</span>
          <span><i className="lg diamond" /> escalated a finding to a person</span>
          <span><i className="lg band held" /> held by a loop-scoped blocker</span>
          <span className="muted">Click a dot to inspect that tick · drag to scrub · space plays · ← → step ticks</span>
        </div>
        {run.error && <div className="error">Simulation error: {run.error}</div>}
      </section>
      <section className="panel">
        <h2>{worldTitle} <span className="muted small">at {fmt(t)}</span></h2>
        {snap !== undefined ? world(snap, t) : <div className="empty">Nothing yet.</div>}
      </section>
      <div className="bottom">
        <section className="panel">
          <h2>Frame at the playhead</h2>
          <FrameInspector lane={lane} tick={tick} onStep={step} />
        </section>
        <section className="panel">
          <h2>Event log</h2>
          <EventLog events={run.events} t={t} onSeek={(v) => { playback.setPlaying(false); seek(v); }} />
        </section>
      </div>
    </>
  );
}
