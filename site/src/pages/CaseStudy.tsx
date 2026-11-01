import { Blocks } from '../components/Markup';
import { CASE_STUDIES } from '../content/case-studies';
import { SIMS } from '../sims';
import { href } from '../router';

/** A simulation's case study: the job in plain English, and what the loop gives it. */
export function CaseStudy({ simId }: { simId: string }) {
  const sim = SIMS.find((s) => s.id === simId);
  const doc = sim && CASE_STUDIES[sim.id];
  if (!sim || !doc) return <div className="page"><a className="back" href={href({ page: 'simulate' })}>← All simulations</a><p>No case study here.</p></div>;
  const run = (
    <a className="sim-cta" href={href({ page: 'simulate', sim: sim.id })}>
      <span className="sim-cta-kicker">See it run</span>
      <span className="sim-cta-title">{sim.title} simulation →</span>
      <span className="sim-cta-blurb">The real loop code from this repository, on a virtual clock in your browser.</span>
    </a>
  );
  return (
    <article className="lesson case-study">
      <a className="back" href={href({ page: 'simulate' })}>← All simulations</a>
      <div className="lesson-kicker">Case study · runs for {sim.runsFor}</div>
      <h1>{doc.title}</h1>
      <p className="lesson-summary">{doc.summary}</p>
      <div className="prose"><Blocks blocks={doc.blocks} /></div>
      {run}
    </article>
  );
}
