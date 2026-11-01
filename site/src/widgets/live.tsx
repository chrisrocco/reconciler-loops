/** Widgets that run real loop code: a simulated experiment's frames, and the experiment's own plan. */
import { useEffect, useMemo, useState } from 'react';
import { buildFrame, newMemory } from '../../../src/core/reconcile';
import { experimentSpec, type ExpWorld, type GuardrailReading, type Triage } from '../../../src/scenarios/experiment';
import { STANDARD_RAMP } from '../../../src/fakes/prod-world';
import { SCENARIOS } from '../../../src/fakes/catalog';
import { fmt } from '../../../src/runtime/sim';
import { EXP, runScenario, type SimRun } from '../sims/experiment/run';
import { FrameInspector } from '../components/FrameInspector';

/** Scrub through the real frames of a simulated quick-fix ramp. */
export function FrameWidget() {
  const [run, setRun] = useState<SimRun>();
  const [i, setI] = useState(0);
  useEffect(() => {
    let live = true;
    runScenario(SCENARIOS.find((s) => s.id === 'quick-fix')!).then((r) => {
      if (!live) return;
      setRun(r);
      const lane = r.lanes.find((l) => l.wf === EXP)!;
      setI(Math.max(0, lane.ticks.findIndex((t) => t.findings.some((f) => f.startsWith('regression:')))));
    });
    return () => { live = false; };
  }, []);
  if (!run) return <div className="w"><div className="w-title">A real frame</div><div className="muted">Running a simulated ramp…</div></div>;
  const lane = run.lanes.find((l) => l.wf === EXP)!;
  const tick = lane.ticks[i]!;
  return (
    <div className="w">
      <div className="w-title">Real frames from a simulated ramp (a quick-fix regression)</div>
      <label className="range">Tick {i + 1} of {lane.ticks.length} · {fmt(tick.at)}
        <input type="range" min={0} max={lane.ticks.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))} />
      </label>
      <FrameInspector lane={lane} tick={tick} onStep={(d) => setI(Math.max(0, Math.min(lane.ticks.length - 1, i + d)))} />
    </div>
  );
}

const STAGE_NAMES = STANDARD_RAMP.map((s) => `${s.percent}%`);

/** Edit a frame; the experiment's real plan turns it into actions. */
export function PlanShape() {
  const [dead, setDead] = useState(true);
  const [breach, setBreach] = useState<'none' | 'mild' | 'severe'>('severe');
  const [route, setRoute] = useState<Triage['route']>('investigate');
  const [soaked, setSoaked] = useState(true);
  const [stage, setStage] = useState(2);

  const plan = useMemo(() => {
    const now = 30 * 24 * 3600_000;
    const reading = (g: string, fail: boolean): GuardrailReading => ({ guardrail: g, verdict: fail ? 'fail' : 'pass', value: fail ? 420 : 240, threshold: 300, severity: breach === 'severe' ? 'severe' : 'mild', signature: fail ? 'p99 regression' : undefined });
    const readings = [reading('latency_p99', breach !== 'none'), reading('error_rate', false)];
    const world: ExpWorld = {
      exp: { id: 'E1', flagName: 'checkout_v2', launchBug: 1001, stages: STANDARD_RAMP, stage, peakStage: stage, stageEnteredAt: soaked ? now - 4 * 24 * 3600_000 : now - 3600_000, status: 'running' },
      candidates: [], readings, fixes: [], pages: [],
      bugs: dead ? [{ id: 'B-7', key: 'k', title: 'error spike in auth', parent: 'exp:checkout_v2', finding: `regression:s${stage}`, signature: 's', depth: 1, status: 'open', createdAt: now - 3600_000, notes: [] }] : [],
      investigations: dead ? { 'B-7': 'terminated' } : {},
    };
    // One finding for every guardrail failing together, as the experiment's observe builds it.
    const failing = readings.filter((r) => r.verdict === 'fail');
    const findings = failing.length ? [{ id: `regression:s${stage}`, kind: 'regression' as const, severity: 'blocking' as const, summary: '', data: { failing, severity: breach === 'severe' ? 'severe' as const : 'mild' as const, peakStage: stage } }] : [];
    const blockers = world.bugs.map((b) => ({ id: `bug:${b.id}`, kind: 'child-bug', on: [b.finding], scope: 'loop' as const, summary: b.title }));
    const frame = buildFrame<ExpWorld, (typeof findings)[number], Triage>({ world, findings, blockers }, newMemory(0), now, {});
    const triage: Triage = route === 'quick-fix' ? { route, patch: { summary: 'patch', ref: 'D1' } } : route === 'investigate' ? { route, title: 'p99 regression', hypothesis: '' } : { route, reason: 'no automated response' };
    const assessments = Object.fromEntries(frame.open.map((f) => [f.id, triage]));
    const spec = experimentSpec({} as never, {} as never, { flagName: 'checkout_v2' });
    return spec.plan({ ...frame, assessments } as never);
  }, [dead, breach, route, soaked, stage]);

  const phaseOf = (k: string) => (k.startsWith('start:') ? 'Repair' : k.startsWith('advance') || k === 'conclude' ? 'Move forward' : 'Respond');
  return (
    <div className="w">
      <div className="w-title">The shape of plan: repair, respond, move forward</div>
      <div className="w-controls grid2">
        <label className="check"><input type="checkbox" checked={dead} onChange={(e) => setDead(e.target.checked)} /> Bug B-7 is open, but its investigation workflow died</label>
        <label className="field">Latency breach
          <select value={breach} onChange={(e) => setBreach(e.target.value as typeof breach)}><option value="none">none</option><option value="mild">mild</option><option value="severe">severe</option></select>
        </label>
        {breach !== 'none' && (
          <label className="field">Triage says
            <select value={route} onChange={(e) => setRoute(e.target.value as Triage['route'])}><option value="quick-fix">quick fix</option><option value="investigate">investigate</option><option value="escalate">escalate</option></select>
          </label>
        )}
        <label className="field">Stage
          <select value={stage} onChange={(e) => setStage(Number(e.target.value))}>{STAGE_NAMES.map((n, j) => <option key={j} value={j}>{n}</option>)}</select>
        </label>
        <label className="check"><input type="checkbox" checked={soaked} onChange={(e) => setSoaked(e.target.checked)} /> The soak time at this stage is up</label>
      </div>
      <div className="plan-out">
        {(['Repair', 'Respond', 'Move forward'] as const).map((ph) => {
          const acts = plan.actions.filter((a) => phaseOf(a.key) === ph);
          return (
            <div key={ph} className="plan-phase">
              <div className="plan-phase-title">{ph}</div>
              {acts.length ? acts.map((a) => <code key={a.key}>{a.key}</code>) : <span className="none">nothing</span>}
            </div>
          );
        })}
      </div>
      <div className="w-foot">These actions come from the experiment's real <code>plan</code> in <code>src/scenarios/experiment.ts</code>. {plan.note && <>Note: {plan.note}</>} Moving forward needs a clean frame: no findings and no blockers.</div>
    </div>
  );
}
