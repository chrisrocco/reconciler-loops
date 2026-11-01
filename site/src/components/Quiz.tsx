import type { Question } from '../content/schema';
import { useProgress } from '../progress';
import { Inline } from './Markup';

/** Multiple-choice questions. Each answer is checked at once, with the reasoning shown. */
export function Quiz({ lesson, questions }: { lesson: string; questions: Question[] }) {
  const { progress, answer } = useProgress();
  const answered = progress[lesson]?.answered ?? {};
  const right = questions.filter((q, i) => answered[i] === q.answer).length;
  const allRight = right === questions.length;

  return (
    <section className="quiz" aria-labelledby={`quiz-${lesson}`}>
      <div className="quiz-head">
        <h2 id={`quiz-${lesson}`}>Check your understanding</h2>
        <span className={`quiz-score ${allRight ? 'all' : ''}`}>{right} / {questions.length} correct</span>
      </div>
      {questions.map((q, i) => {
        const chosen = answered[i];
        const done = chosen !== undefined;
        return (
          <div key={i} className="question">
            <p className="q"><span className="q-num">{i + 1}</span><span><Inline text={q.q} /></span></p>
            <div className="options" role="radiogroup" aria-label={`Question ${i + 1}`}>
              {q.options.map((o, j) => {
                const state = !done ? '' : j === q.answer ? 'right' : j === chosen ? 'wrong' : 'dim';
                return (
                  <button key={j} role="radio" aria-checked={chosen === j} className={`option ${state}`}
                    onClick={() => answer(lesson, i, j, questions.every((qq, k) => (k === i ? j : answered[k]) === qq.answer))}>
                    <span className="option-mark" aria-hidden>{state === 'right' ? '✓' : state === 'wrong' ? '✕' : String.fromCharCode(65 + j)}</span>
                    <span><Inline text={o} /></span>
                  </button>
                );
              })}
            </div>
            {done && (
              <p className={`explain ${chosen === q.answer ? 'right' : 'wrong'}`}>
                <strong>{chosen === q.answer ? 'Right. ' : 'Not quite. '}</strong><Inline text={q.explain} />
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
