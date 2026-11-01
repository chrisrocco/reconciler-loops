import { useEffect, useState } from 'react';
import { Sim, DAY } from '../../../../src/runtime/sim';
import { campaignWorkflow, componentMigrationWorkflow } from '../../../../src/scenarios/migration';
import { MigrationWorld, SAMPLE_APP, type ComponentKind } from '../../../../src/fakes/migration-world';
import { Recorder, type TraceRun } from '../trace';
import { SimShell, type Variant } from '../../components/SimShell';
import { TracePlayer } from '../../components/TracePlayer';

const CAMPAIGN = 'campaign:new-ui';

const VARIANTS: (Variant & { maxInFlight: number; maxPerOwner: number })[] = [
  { id: 'balanced', title: 'Balanced limits', maxInFlight: 4, maxPerOwner: 2, blurb: 'At most 4 migrations in flight, 2 per owning team, smallest first. Components wait on the old-framework components they use (prerequisites), which never counts toward their age.' },
  { id: 'wide', title: 'Wide open', maxInFlight: 8, maxPerOwner: 4, blurb: 'Up to 8 in flight and 4 per team. Faster, but each team reviews more at once. Prerequisites still gate the order: a component can\'t start until its dependencies have moved.' },
  { id: 'narrow', title: 'One at a time', maxInFlight: 1, maxPerOwner: 1, blurb: 'A single migration at a time. Slow and steady, and the same rules apply: the campaign\'s policy is pure, so changing the limits changes nothing else.' },
];

type State = 'waiting' | 'ready' | 'converting' | 'in-review' | 'with-team' | 'done';
interface Card { path: string; owner: string; lines: number; kind: ComponentKind; state: State; needs: string[]; rev?: number; review?: string; by?: string }
interface Snap { cards: Card[]; allowlist: number; cleanup: string }

function snapshot(w: MigrationWorld): Snap {
  const cards = SAMPLE_APP.map((spec): Card => {
    const done = w.migrated.find((m) => m.path === spec.path);
    const change = [...w.changes.values()].find((c) => c.path === spec.path && c.state === 'open');
    const needs = (spec.uses ?? []).filter((d) => w.legacy.has(d));
    const state: State = done ? 'done' : change?.withTeam ? 'with-team' : change ? (change.review === 'none' ? 'converting' : 'in-review') : needs.length ? 'waiting' : 'ready';
    return { path: spec.path, owner: spec.owner, lines: spec.lines, kind: spec.kind, state, needs, rev: change?.rev, review: change?.review, by: done?.by };
  });
  return { cards, allowlist: w.allowlist.length, cleanup: w.cleanup.doneAt !== undefined ? 'done' : w.cleanup.startedAt !== undefined ? 'running' : 'not started' };
}

async function run(v: (typeof VARIANTS)[number]) {
  const sim = new Sim();
  const world = new MigrationWorld(sim, SAMPLE_APP);
  const rec = new Recorder(sim, () => snapshot(world));
  sim.register('campaign', rec.tracked((rt, input: any) => campaignWorkflow(rt, rt.activities(world.activities()), input, { onTick: rec.onTick(rt.workflowId) })));
  sim.register('component-migration', rec.tracked((rt, input: any) => componentMigrationWorkflow(rt, rt.activities(world.activities()), input, { onTick: rec.onTick(rt.workflowId) })));
  sim.start(CAMPAIGN, 'campaign', { name: 'new-ui', maxInFlight: v.maxInFlight, maxPerOwner: v.maxPerOwner });
  return rec.finish(CAMPAIGN, (wf) => (wf === CAMPAIGN ? 0 : 1), { maxMs: 200 * DAY });
}

const OWNERS = [...new Set(SAMPLE_APP.map((c) => c.owner))];
const STATE_LABEL: Record<State, string> = {
  waiting: 'waiting on a prerequisite', ready: 'ready, queued behind the limits', converting: 'converting and verifying',
  'in-review': 'in review', 'with-team': 'escalated to its team', done: 'migrated',
};

export function MigrationSim({ variant }: { variant?: string }) {
  const v = VARIANTS.find((x) => x.id === variant) ?? VARIANTS[0]!;
  const [result, setResult] = useState<{ id: string; run: TraceRun<Snap> }>();
  useEffect(() => { let live = true; run(v).then((r) => live && setResult({ id: v.id, run: r })); return () => { live = false; }; }, [v]);
  const r = result?.id === v.id ? result.run : undefined;
  return (
    <SimShell sim="migration" title="Large-scale migration" variants={VARIANTS} variant={v} run={r as TraceRun<unknown>}
      intro={<>A campaign loop moves 14 components to a new framework, starting one child loop per component. Each child converts, verifies, goes through review and submits.</>}>
      {r && <TracePlayer run={r} worldTitle="The codebase" seconds={30} label={(wf) => wf.replace(/^migrate:/, '↳ ')} world={(s) => (
        <div className="codebase">
          <div className="codebase-legend">
            {(Object.keys(STATE_LABEL) as State[]).map((k) => <span key={k}><i className={`state-dot ${k}`} />{STATE_LABEL[k]}</span>)}
          </div>
          <div className="owner-cols">
            {OWNERS.map((o) => (
              <div key={o} className="owner-col">
                <div className="owner-name">{o}</div>
                {s.cards.filter((c) => c.owner === o).map((c) => (
                  <div key={c.path} className={`comp-card ${c.state}`} title={STATE_LABEL[c.state]}>
                    <div className="comp-path mono">{c.path.split('/')[1]}</div>
                    <div className="comp-meta">
                      {c.state === 'waiting' && <>needs {c.needs.map((d) => d.split('/')[1]).join(', ')}</>}
                      {c.state === 'ready' && <>{c.lines} lines</>}
                      {(c.state === 'converting' || c.state === 'in-review') && <>patchset {c.rev} · {c.review === 'none' ? 'verifying' : c.review}</>}
                      {c.state === 'with-team' && <>its team is migrating it</>}
                      {c.state === 'done' && <>by {c.by === 'agent' ? 'the agent' : c.by === 'team' ? 'its team' : 'a person, by hand'}</>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="cl-meta">Allowlist: {s.allowlist} paths · cleanup {s.cleanup}</div>
        </div>
      )} />}
    </SimShell>
  );
}
