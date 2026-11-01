import { SIMS } from '../sims';
import { href } from '../router';

export function Simulate({ simId, variant }: { simId?: string; variant?: string }) {
  const sim = SIMS.find((s) => s.id === simId);
  if (sim) return <sim.Component variant={variant} />;
  return (
    <div className="page">
      <header className="page-head">
        <h1>Simulations</h1>
        <p>Every simulation runs the real loop code from this repository in your browser, on a virtual clock: weeks pass in under a second. Then you replay it, tick by tick.</p>
      </header>
      <div className="sim-grid">
        {SIMS.map((s) => (
          <a key={s.id} className="sim-card" href={href({ page: 'simulate', sim: s.id })}>
            <div className="sim-card-top">
              <span className="sim-card-title">{s.title}</span>
              <span className="runs-for">runs for {s.runsFor}</span>
            </div>
            <p>{s.blurb}</p>
            <ul>{s.watch.map((w) => <li key={w}>{w}</li>)}</ul>
            <span className="sim-card-go">Run it →</span>
          </a>
        ))}
      </div>
    </div>
  );
}
