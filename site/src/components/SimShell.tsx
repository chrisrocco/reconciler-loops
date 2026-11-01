import type { ReactNode } from 'react';
import { fmt } from '../../../src/runtime/sim';
import { href } from '../router';
import type { TraceRun } from '../sims/trace';

export interface Variant { id: string; title: string; blurb: string }

interface Props {
  sim: string;
  title: string;
  intro: ReactNode;
  variants: Variant[];
  variant: Variant;
  /** Extra controls under the variants (a seed, a world picker). */
  controls?: ReactNode;
  run?: TraceRun<unknown>;
  stats?: { label: string; value: string | number }[];
  children: ReactNode;
}

/** The layout every simulation shares: variants on the left, the run on the right. */
export function SimShell({ sim, title, intro, variants, variant, controls, run, stats, children }: Props) {
  const status = run?.result?.status ?? (run ? 'running' : '');
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <a className="back" href={href({ page: 'simulate' })}>← All simulations</a>
          <div className="brand-title">{title}</div>
          <div className="brand-sub">{intro}</div>
          <a className="case-link" href={href({ page: 'case-study', sim })}>Read the case study →</a>
        </div>
        {controls && <div className="world-picker">{controls}</div>}
        <nav className="scenarios" aria-label="Variants">
          {variants.map((v) => (
            <a key={v.id} href={href({ page: 'simulate', sim, variant: v.id })} className={`scenario ${v.id === variant.id ? 'active' : ''}`}>
              <span className="scenario-title">{v.title}</span>
              <span className="scenario-blurb">{v.blurb}</span>
            </a>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="head">
          <div className="head-text">
            <h1>{variant.title}</h1>
            <p>{variant.blurb}</p>
          </div>
          {run && (
            <div className="outcome">
              <span className={`pill ${status}`}>{status}</span>
              <div className="stats">
                <div className="stat"><div className="stat-value mono">{fmt(run.end)}</div><div className="stat-label">simulated</div></div>
                <div className="stat"><div className="stat-value mono">{run.lanes.length}</div><div className="stat-label">loops</div></div>
                <div className="stat"><div className="stat-value mono">{run.lanes.reduce((n, l) => n + l.ticks.length, 0)}</div><div className="stat-label">ticks</div></div>
                {stats?.map((s) => <div key={s.label} className="stat"><div className="stat-value mono">{s.value}</div><div className="stat-label">{s.label}</div></div>)}
              </div>
              {run.result?.reason && <div className="outcome-reason">{run.result.reason}</div>}
            </div>
          )}
        </header>
        {run ? children : <div className="panel loading">Running the simulation in your browser…</div>}
      </main>
    </div>
  );
}
