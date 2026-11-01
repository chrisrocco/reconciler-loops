import { useEffect, useState } from 'react';
import { Sim, DAY, fmt } from '../../../../src/runtime/sim';
import { onCallWorkflow } from '../../../../src/scenarios/on-call';
import { OnCallWorld, type OnCallStats } from '../../../../src/fakes/on-call-world';
import { Recorder, type TraceRun } from '../trace';
import { SimShell, type Variant } from '../../components/SimShell';
import { TracePlayer } from '../../components/TracePlayer';

const WF = 'oncall:infra';

const VARIANTS: (Variant & { days: number })[] = [
  { id: 'month', title: 'A month on call', days: 30, blurb: 'Builds break, tests turn flaky, a daily release sometimes trips a canary alert. The agent reverts, quarantines and pauses at once, and files one issue per problem for the owner.' },
  { id: 'quarter', title: 'A quarter on call', days: 90, blurb: 'Ninety days with no goal and no time budget. Retention forgets old memory, so the loop could run forever. Owners who ignore an issue for three days see it escalated to their lead.' },
];

interface Snap {
  targets: { target: string; red: boolean; since?: number; suspects?: string[] }[];
  tests: { test: string; state: 'ok' | 'flaky' | 'quarantined' }[];
  releases: { id: string; state: string; alert?: string }[];
  issues: { id: string; finding: string; owner: string; createdAt: number; escalated?: boolean }[];
  reverts: number;
}

const TARGETS = ['search', 'checkout', 'ads', 'maps'];

function snapshot(w: OnCallWorld): Snap {
  return {
    targets: TARGETS.map((t) => { const b = w.broken.get(`//${t}:server`); return { target: `//${t}:server`, red: !!b, since: b?.since, suspects: b?.suspects }; }),
    tests: TARGETS.flatMap((t) => [`${t}/integration_test`, `${t}/e2e_test`]).map((test) => { const f = w.flaky.get(test); return { test, state: !f ? 'ok' : f.quarantined ? 'quarantined' : 'flaky' }; }),
    releases: w.releases.slice(-4).map((r) => ({ id: r.id, state: r.state, alert: r.alerts[0]?.alert })),
    issues: [...w.issues.values()].filter((i) => i.status === 'open').map((i) => ({ id: i.id, finding: i.finding, owner: i.owner, createdAt: i.createdAt, escalated: i.escalated })),
    reverts: w.reverts.length,
  };
}

async function run(v: (typeof VARIANTS)[number], seed: number) {
  const sim = new Sim();
  const world = new OnCallWorld(sim, seed, v.days);
  const rec = new Recorder(sim, () => snapshot(world));
  sim.register('oncall', rec.tracked((rt, input: any) => onCallWorkflow(rt, rt.activities(world.activities()), input, { onTick: rec.onTick(rt.workflowId) })));
  sim.start(WF, 'oncall', { team: 'infra' });
  const r = await rec.finish(WF, () => 0, { until: () => sim.now >= v.days * DAY });
  return { ...r, stats: world.stats, result: { status: 'running', reason: `still running after ${v.days} days: it has no goal and no time budget` } };
}

export function OnCallSim({ variant }: { variant?: string }) {
  const v = VARIANTS.find((x) => x.id === variant) ?? VARIANTS[0]!;
  const [seed, setSeed] = useState(1);
  const [result, setResult] = useState<{ key: string; run: TraceRun<Snap> & { stats: OnCallStats } }>();
  const key = `${v.id}:${seed}`;
  useEffect(() => { let live = true; run(v, seed).then((r) => live && setResult({ key, run: r })); return () => { live = false; }; }, [v, seed, key]);
  const r = result?.key === key ? result.run : undefined;
  return (
    <SimShell sim="on-call" title="On-call agent" variants={VARIANTS} variant={v} run={r as TraceRun<unknown>}
      stats={r ? [{ label: 'breakages', value: r.stats.breaks }, { label: 'bad releases', value: r.stats.badReleases }, { label: 'to the lead', value: r.stats.leadFixes }] : undefined}
      intro={<>A loop that never ends. Each problem is mitigated locally and delegated durably: one issue for its owner.</>}
      controls={<div className="seed"><label htmlFor="oc-seed">Seed</label>
        <input id="oc-seed" type="number" min={1} value={seed} onChange={(e) => setSeed(Math.max(1, Number(e.target.value) || 1))} />
        <button onClick={() => setSeed(seed + 1)}>Next seed</button></div>}>
      {r && <TracePlayer run={r} worldTitle="The org" seconds={40} world={(s, t) => (
        <div className="org-board">
          <div className="board-col">
            <div className="board-title">Builds</div>
            {s.targets.map((x) => (
              <div key={x.target} className={`board-row ${x.red ? 'bad' : 'good'}`}>
                <span className="mono">{x.target}</span>
                <span>{x.red ? `red ${fmt(t - x.since!).replace(/^d0\+/, '')}` : 'green'}</span>
              </div>
            ))}
          </div>
          <div className="board-col">
            <div className="board-title">Tests</div>
            {s.tests.map((x) => <div key={x.test} className={`board-row ${x.state === 'ok' ? 'good' : x.state === 'flaky' ? 'bad' : 'warn'}`}><span className="mono">{x.test}</span><span>{x.state}</span></div>)}
          </div>
          <div className="board-col">
            <div className="board-title">Releases</div>
            {s.releases.map((x) => <div key={x.id} className={`board-row ${x.alert ? 'bad' : x.state === 'paused' ? 'warn' : 'good'}`}><span className="mono">{x.id}</span><span>{x.state}{x.alert ? ` · ${x.alert}` : ''}</span></div>)}
          </div>
          <div className="board-col wide">
            <div className="board-title">Open issues ({s.issues.length})</div>
            {s.issues.length === 0 && <div className="empty">none</div>}
            {s.issues.slice(0, 8).map((i) => (
              <div key={i.id} className={`board-row ${i.escalated ? 'bad' : ''}`}>
                <span className="mono">{i.id} {i.finding}</span>
                <span>{i.escalated ? 'with the lead' : i.owner} · {Math.floor((t - i.createdAt) / DAY)}d</span>
              </div>
            ))}
          </div>
        </div>
      )} />}
    </SimShell>
  );
}
