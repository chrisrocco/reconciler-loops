import { SIMS } from '../sims';
import { href } from '../router';

export function Simulate({ simId, variant }: { simId?: string; variant?: string }) {
  const sim = SIMS.find((s) => s.id === simId);
  if (sim) return <sim.Component variant={variant} />;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Simulations</h1>
        <p>Each simulation starts with a case study: the job in plain English, and what the loop gives it. Every simulation runs the real loop code from this repository in your browser, on a virtual clock: weeks pass in under a second. Then you replay it, tick by tick.</p>
      </header>
      <div className="sim-grid">
        {SIMS.map((s) => (
          <div key={s.id} className="sim-card">
            <div className="sim-card-top">
              <span className="sim-card-title">{s.title}</span>
              <span className="runs-for">runs for {s.runsFor}</span>
            </div>
            <p>{s.blurb}</p>
            <ul>{s.watch.map((w) => <li key={w}>{w}</li>)}</ul>
            <div className="sim-card-links">
              <a href={href({ page: 'case-study', sim: s.id })}>Read the case study</a>
              <a className="sim-card-go" href={href({ page: 'simulate', sim: s.id })}>Run it →</a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
