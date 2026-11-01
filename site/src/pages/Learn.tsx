import { LESSONS } from '../content/lessons';
import type { Part } from '../content/schema';
import { Blocks } from '../components/Markup';
import { Quiz } from '../components/Quiz';
import { Widget } from '../widgets';
import { useProgress } from '../progress';
import { href } from '../router';
import { SIMS } from '../sims';

const PARTS: Part[] = ['Why', 'Core concepts', 'In code', 'Conventions', 'Examples', 'Running loops'];

export function Learn({ lessonId }: { lessonId?: string }) {
  const { progress, reset } = useProgress();
  const i = Math.max(0, LESSONS.findIndex((l) => l.id === lessonId));
  const lesson = LESSONS[i]!;
  const prev = LESSONS[i - 1], next = LESSONS[i + 1];
  const done = LESSONS.filter((l) => progress[l.id]?.done).length;
  const at = lesson.widgetAfter ?? lesson.body.length;
  const sim = lesson.simulation && SIMS.find((s) => s.id === lesson.simulation);

  return (
    <div className="learn">
      <aside className="lesson-nav" aria-label="Lessons">
        <div className="lesson-progress">
          <div className="bar"><div style={{ width: `${(done / LESSONS.length) * 100}%` }} /></div>
          <span>{done} of {LESSONS.length} lessons complete</span>
          {done > 0 && <button className="link" onClick={reset}>reset</button>}
        </div>
        {PARTS.map((part) => {
          const ls = LESSONS.filter((l) => l.part === part);
          if (!ls.length) return null;
          return (
            <div key={part} className="lesson-part">
              <div className="lesson-part-title">{part}</div>
              {ls.map((l) => (
                <a key={l.id} href={href({ page: 'learn', lesson: l.id })} className={`lesson-link ${l.id === lesson.id ? 'on' : ''}`}>
                  <span className={`lesson-check ${progress[l.id]?.done ? 'done' : ''}`} aria-label={progress[l.id]?.done ? 'complete' : undefined} />
                  {l.title}
                </a>
              ))}
            </div>
          );
        })}
      </aside>

      <article className="lesson" key={lesson.id}>
        <div className="lesson-kicker">{lesson.part} · {i + 1} of {LESSONS.length}</div>
        <h1>{lesson.title}</h1>
        <p className="lesson-summary">{lesson.summary}</p>
        <div className="prose">
          <Blocks blocks={lesson.body.slice(0, at)} />
          {lesson.widget && <div className="widget-frame"><Widget id={lesson.widget} /></div>}
          <Blocks blocks={lesson.body.slice(at)} />
        </div>
        {sim && (
          <a className="sim-cta" href={href({ page: 'simulate', sim: sim.id })}>
            <span className="sim-cta-kicker">See it run</span>
            <span className="sim-cta-title">{sim.title} simulation →</span>
            <span className="sim-cta-blurb">{sim.blurb}</span>
          </a>
        )}
        <Quiz lesson={lesson.id} questions={lesson.quiz} />
        <div className="pager">
          {prev ? <a href={href({ page: 'learn', lesson: prev.id })}>← {prev.title}</a> : <span />}
          {next ? <a href={href({ page: 'learn', lesson: next.id })}>{next.title} →</a> : <a href={href({ page: 'simulate' })}>Try the simulations →</a>}
        </div>
      </article>
    </div>
  );
}
