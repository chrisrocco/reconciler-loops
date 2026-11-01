import { useEffect, useState } from 'react';
import { href } from '../router';
import { SIMS } from '../sims';
import { LESSONS } from '../content/lessons';

const STEPS = [
  { name: 'Observe', text: 'Read the real systems: metrics, the bug tracker, the deploy system.' },
  { name: 'Sort', text: 'Each finding is open, claimed by an action in flight, or blocked by work the world shows.' },
  { name: 'Decide', text: 'A pure plan turns the frame into actions, each with a key that never runs twice.' },
  { name: 'Act', text: 'Escalations first, then the plan. Mitigate locally, delegate durably.' },
  { name: 'Wait', text: 'Sleep until the next poll, or until a hint wakes the loop early.' },
];

export function Home() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-text">
          <h1>Agent workflows that run for weeks and keep the work moving.</h1>
          <p className="lede">
            A <b>reconciler loop</b> looks at the world, works out what is wrong and what is already being handled,
            takes at most one safe action per problem, and waits. Then it does it again. Nothing it needs lives
            only in its memory, so it survives crashes, restarts, and people changing things behind its back.
          </p>
          <div className="hero-cta">
            <a className="btn primary" href={href({ page: 'learn', lesson: LESSONS[0]?.id })}>Start the tutorial</a>
            <a className="btn" href={href({ page: 'simulate' })}>Watch it run</a>
          </div>
          <p className="hero-note">{LESSONS.length} short lessons with quizzes · {SIMS.length} live simulations · the same pattern Kubernetes controllers use, applied to agents</p>
        </div>
        <LoopDiagram step={step} onStep={setStep} />
      </section>

      <section className="home-band">
        <h2>Why not just write the steps?</h2>
        <div className="contrast">
          <div className="contrast-card bad">
            <div className="contrast-title">A script of steps</div>
            <p>Ramp to 5%, wait a day, check the metrics, ramp to 25%. Over weeks, a webhook is dropped, a worker restarts mid-step, a person rolls the experiment back by hand. The script still thinks it's on step three, and acts on things that are no longer true.</p>
          </div>
          <div className="contrast-card good">
            <div className="contrast-title">A loop over the world</div>
            <p>Every tick re-reads where things actually stand and decides the next step from that. Nothing depends on remembering where it was, so a missed event costs a few minutes, never correctness.</p>
          </div>
        </div>
      </section>

      <section className="home-band">
        <h2>Five loops, one pattern</h2>
        <div className="sim-grid compact">
          {SIMS.map((s) => (
            <a key={s.id} className="sim-card" href={href({ page: 'simulate', sim: s.id })}>
              <div className="sim-card-top"><span className="sim-card-title">{s.title}</span><span className="runs-for">{s.runsFor}</span></div>
              <p>{s.blurb}</p>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function LoopDiagram({ step, onStep }: { step: number; onStep: (i: number) => void }) {
  const R = 118, C = 160;
  const pos = STEPS.map((_, i) => {
    const a = -Math.PI / 2 + (i / STEPS.length) * Math.PI * 2;
    return { x: C + R * Math.cos(a), y: C + R * Math.sin(a) };
  });
  return (
    <figure className="loop-diagram" aria-label="One tick of a reconciler loop">
      <svg viewBox="0 0 320 320" role="img">
        <circle cx={C} cy={C} r={R} className="ring" />
        <circle cx={C} cy={C} r={R} className="ring-progress" style={{ strokeDashoffset: 2 * Math.PI * R * (1 - (step + 1) / STEPS.length) }}
          strokeDasharray={2 * Math.PI * R} transform={`rotate(-90 ${C} ${C})`} />
        {pos.map((p, i) => (
          <g key={i} className={`node ${i === step ? 'on' : ''}`} onClick={() => onStep(i)} onMouseEnter={() => onStep(i)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onStep(i); }} aria-label={STEPS[i]!.name}>
            <circle cx={p.x} cy={p.y} r={30} />
            <text x={p.x} y={p.y + 4} textAnchor="middle">{STEPS[i]!.name}</text>
          </g>
        ))}
        <text x={C} y={C - 6} textAnchor="middle" className="center-title">tick</text>
        <text x={C} y={C + 14} textAnchor="middle" className="center-sub">every few minutes, for weeks</text>
      </svg>
      <figcaption><b>{STEPS[step]!.name}.</b> {STEPS[step]!.text}</figcaption>
    </figure>
  );
}
