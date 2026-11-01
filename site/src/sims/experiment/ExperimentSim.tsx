import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmt } from '../../../../src/runtime/sim';
import { DAY, HOUR } from '../../../../src/core/time';
import { SCENARIOS } from '../../../../src/fakes/catalog';
import { RAMP_POLICIES, RAMP_POLICY_NAMES } from '../../../../src/fakes/prod-world';
import { href } from '../../router';
import { EXP, runScenario, type SimRun, type Tick, type WorldKind } from './run';
import { usePlayback } from '../../hooks';
import { Timeline } from './Timeline';
import { FrameInspector } from '../../components/FrameInspector';
import { EventLog } from '../../components/EventLog';
import { Friction } from './Friction';

/** The experiment ramp, with every catalog scenario as a variant and any ramp policy. */
export function ExperimentSim({ variant }: { variant?: string }) {
  const scenarioId = SCENARIOS.find((s) => s.id === variant)?.id ?? SCENARIOS[0]!.id;
  const [world, setWorld] = useState<WorldKind>('realistic');
  const [policyFor, setPolicy] = useState<{ id: string; policy: string }>();
  const rampPolicy = policyFor?.id === scenarioId ? policyFor.policy : SCENARIOS.find((s) => s.id === scenarioId)!.rampPolicy ?? 'standard';
  const [seed, setSeed] = useState(1);
  const [run, setRun] = useState<SimRun>();
  const [t, setT] = useState(0);
  const [laneId, setLaneId] = useState(EXP);
  // A clicked tick stays selected even when several ticks share its timestamp.
  const [pinned, setPinned] = useState<number>();

  useEffect(() => {
    let live = true;
    const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
    runScenario(scenario, world, seed, rampPolicy).then((r) => {
      if (!live) return;
      setRun(r);
      setT(incidentWindow(r)?.[1] ?? r.end);
      setLaneId(EXP);
      setPinned(undefined);
    });
    return () => { live = false; };
  }, [scenarioId, world, seed, rampPolicy]);
  const multiArm = !!SCENARIOS.find((s) => s.id === scenarioId)!.arms;
  const shownWorld: WorldKind = multiArm ? 'ideal' : world;
  const current = run && run.scenario.id === scenarioId && (run.world === world || multiArm) && run.seed === seed && run.rampPolicy === rampPolicy;

  const [zoom, setZoom] = useState<'incident' | 'all'>('incident');
  const incident = useMemo(() => (run ? incidentWindow(run) : undefined), [run]);
  const [from, to] = zoom === 'incident' && incident ? incident : [0, run?.end ?? 0];

  const seek = useCallback((v: number) => { setT(v); setPinned(undefined); }, []);
  const playback = usePlayback(from, to, t, seek);

  const lane = run?.lanes.find((l) => l.wf === laneId) ?? run?.lanes[0];
  const tick: Tick | undefined = useMemo(() => {
    if (!lane) return undefined;
    if (pinned !== undefined) return lane.ticks[pinned];
    let last: Tick | undefined;
    for (const tk of lane.ticks) if (tk.at <= t) last = tk;
    return last;
  }, [lane, pinned, t]);

  const selectTick = (tk: Tick) => { playback.setPlaying(false); setLaneId(tk.wf); setT(tk.at); setPinned(tk.idx); };
  const step = (delta: number) => {
    if (!lane) return;
    const next = lane.ticks[Math.max(0, Math.min(lane.ticks.length - 1, (tick?.idx ?? -1) + delta))];
    if (next) selectTick(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); playback.toggle(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <a className="back" href={href({ page: 'simulate' })}>← All simulations</a>
          <div className="brand-title">Experiment ramp</div>
          <div className="brand-sub">An agent ramps an experiment through traffic stages, watching guardrails, investigating regressions with child loops. Each scenario runs the real <span className="mono">src/</span> code in your browser.</div>
        </div>
        <div className="world-picker">
          <label className="field">Ramp policy
            <select value={rampPolicy} onChange={(e) => setPolicy({ id: scenarioId, policy: e.target.value })}>
              {RAMP_POLICY_NAMES.map((p) => <option key={p} value={p}>{p}: {RAMP_POLICIES[p]!.map((s) => `${s.percent}%`).join(' → ')}</option>)}
            </select>
          </label>
          {multiArm && <p className="world-blurb">Multi-arm experiments run in the idealized world, which models one stage per arm.</p>}
          <div className="segmented full" role="group" aria-label="World">
            <button className={shownWorld === 'realistic' ? 'on' : ''} disabled={multiArm} onClick={() => setWorld('realistic')}>Realistic world</button>
            <button className={shownWorld === 'ideal' ? 'on' : ''} onClick={() => setWorld('ideal')}>Idealized fakes</button>
          </div>
          <p className="world-blurb">
            {shownWorld === 'realistic'
              ? 'Noisy metrics with CIs, lagging search, flaky RPCs, wrong agents, human review in working hours, daily release cuts and weekday rollouts.'
              : 'Perfect systems: exact metrics, instant consistency, an 8h deploy, agents that are always right. Matches the unit tests.'}
          </p>
          {shownWorld === 'realistic' && (
            <div className="seed">
              <label htmlFor="seed">Seed</label>
              <input id="seed" type="number" min={1} value={seed} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) || 1))} />
              <button onClick={() => setSeed(seed + 1)} title="Same scenario, a different draw of the world">Next seed</button>
            </div>
          )}
        </div>
        <nav className="scenarios">
          {SCENARIOS.map((s) => (
            <a key={s.id} className={`scenario ${s.id === scenarioId ? 'active' : ''}`} href={href({ page: 'simulate', sim: 'experiment', variant: s.id })}>
              <span className="scenario-title">{s.title}</span>
              <span className="scenario-blurb">{s.blurb}</span>
            </a>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="head">
          <div className="head-text">
            <h1>{scenario.title}</h1>
            <p>{scenario.blurb}</p>
          </div>
          {current && <Outcome run={run} />}
        </header>

        {!current ? (
          <div className="panel loading">Running simulation…</div>
        ) : (
          <>
            <section className="panel">
              <div className="transport">
                <button className="play" onClick={playback.toggle}>{playback.playing ? 'Pause' : t >= to ? 'Replay' : 'Play'}</button>
                <input
                  className="scrub" type="range" min={from} max={to} step={(to - from) / 2000} value={Math.min(to, Math.max(from, t))}
                  onChange={(e) => { playback.setPlaying(false); seek(Number(e.target.value)); }} aria-label="Simulation time"
                />
                <span className="clock mono">{fmt(t)} <span className="muted">/ {fmt(run.end)}</span></span>
                <div className="segmented" role="group" aria-label="Zoom">
                  <button className={zoom === 'incident' ? 'on' : ''} disabled={!incident} onClick={() => setZoom('incident')}
                    title={incident ? `${fmt(incident[0])} to ${fmt(incident[1])}` : 'Nothing went wrong in this run'}>Incident</button>
                  <button className={zoom === 'all' || !incident ? 'on' : ''} onClick={() => setZoom('all')}>Whole run</button>
                </div>
                <select value={playback.speed} onChange={(e) => playback.setSpeed(Number(e.target.value))} aria-label="Playback speed">
                  {[0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
                </select>
              </div>
              <Timeline
                run={run} from={from} to={to} t={t} onSeek={(v) => { playback.setPlaying(false); seek(v); }}
                selectedLane={lane?.wf ?? EXP} selectedTick={tick}
                onSelectTick={selectTick} onSelectLane={(wf) => { setLaneId(wf); setPinned(undefined); }}
              />
              <Legend realistic={run.world === 'realistic'} />
              {run.error && <div className="error">Simulation error: {run.error}</div>}
            </section>

            {run.stats && (
              <section className="panel">
                <h2>Real-world friction in this run (seed {run.seed})</h2>
                <Friction stats={run.stats} />
              </section>
            )}

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
        )}
      </main>
    </div>
  );
}

function Outcome({ run }: { run: SimRun }) {
  const status = run.result?.status ?? 'unfinished';
  const ticks = run.lanes.reduce((n, l) => n + l.ticks.length, 0);
  const actions = run.lanes.reduce((n, l) => n + l.ticks.reduce((m, tk) => m + tk.acted.length, 0), 0);
  return (
    <div className="outcome">
      <span className={`pill ${status}`}>{status}</span>
      <div className="stats">
        <Stat label="duration" value={fmt(run.end)} />
        <Stat label="loops" value={run.lanes.length} />
        <Stat label="ticks" value={ticks} />
        <Stat label="intents" value={actions} />
        <Stat label="bugs" value={run.bugs.length} />
        <Stat label="fix CLs" value={run.fixes.length} />
      </div>
      <div className="outcome-reason">{run.result?.reason ?? run.escalations[0] ?? ''}</div>
    </div>
  );
}

/**
 * The stretch of the run where something went wrong: from the first breach, rollback,
 * bug, fix or crash to the last one settling, padded by half a day. Undefined if nothing did.
 */
function incidentWindow(run: SimRun): [number, number] | undefined {
  const times: number[] = [];
  for (const r of run.readings) if (r.readings.some((g) => g.verdict === 'fail')) times.push(r.at);
  run.stages.forEach((s, i) => { if (i > 0 && s.percent < run.stages[i - 1]!.percent) times.push(s.at); });
  for (const b of run.bugs) times.push(b.createdAt, b.closedAt ?? run.end);
  for (const f of run.fixes) times.push(f.submittedAt, Math.min(f.inProdAt ?? run.end, run.end));
  for (const p of run.pages) times.push(p.openedAt, p.resolvedAt ?? run.end);
  for (const l of run.lanes) for (const r of l.runs) if (r.outcome && r.outcome !== 'done') times.push(r.end ?? run.end);
  if (!times.length) return undefined;
  const pad = 12 * HOUR;
  const lo = Math.max(0, Math.min(...times) - pad);
  const hi = Math.min(run.end, Math.max(...times) + pad);
  return hi - lo < DAY ? [Math.max(0, hi - DAY), hi] : [lo, hi];
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="stat"><div className="stat-value mono">{value}</div><div className="stat-label">{label}</div></div>;
}

function Legend({ realistic }: { realistic: boolean }) {
  return (
    <div className="legend">
      <span><i className="lg dot idle" /> idle poll</span>
      <span><i className="lg dot acted" /> tick that issued intents</span>
      <span><i className="lg dot signal" /> woken early by a hint</span>
      <span><i className="lg band held" /> held by a loop-scoped blocker</span>
      <span><i className="lg band claimed" /> finding claimed by an in-flight intent</span>
      {realistic ? (
        <>
          <span><i className="lg band review" /> fix CL in presubmit / review</span>
          <span><i className="lg band waiting" /> waiting for the release cut / qualifying</span>
          <span><i className="lg band hatch" /> rolling out (canary → waves)</span>
          <span><i className="lg band weekend" /> weekend</span>
          <span><i className="lg band stalled" /> metrics pipeline stalled</span>
        </>
      ) : <span><i className="lg band hatch" /> fix CL rolling out</span>}
      <span className="muted">Click a dot to inspect that tick · drag to scrub · space plays · ← → step ticks</span>
    </div>
  );
}
