/**
 * The tutorial's content model. Lessons are plain data; the site renders them.
 *
 * Inline text in any string supports `code` (backticks) and **bold**. Nothing else.
 */

/** The interactive demos the site provides. A lesson may embed one, at most. */
export type WidgetId =
  /** Steps through one tick: observe → goal? → decide → act → wait, on a tiny experiment. */
  | 'tick-cycle'
  /** "Same finding or new one?" — pairs of observations; the reader decides, then sees the id. */
  | 'same-finding'
  /** Builds keys with and without attempt numbers, and shows a retry being skipped as already done. */
  | 'keys'
  /** A fix that takes a while to show up: drag the deadline, watch the finding stay claimed or reopen. */
  | 'deadline'
  /** A rollback hides a regression while its fix is still rolling out: blocker vs "status on the finding". */
  | 'blocker-vs-status'
  /** Toggle a blocker and an action in flight, and see the real `buildFrame` sort the finding. */
  | 'sort-finding'
  /** Fixes that don't work: count attempts, watch the finding get escalated, then a person answer it. */
  | 'attempts'
  /** Blocker scope: `loop` vs `finding`, and whether the loop may move forward. */
  | 'hold'
  /** The three reasons to escalate (attempts, age, repeating itself), with prerequisites that don't age. */
  | 'escalation'
  /** The only three ways a loop ends, and the safe hold. */
  | 'endings'
  /** A real frame from a simulated tick, explorable. */
  | 'frame'
  /** Repair → respond → move forward, on a frame the reader edits. */
  | 'plan-shape';

export type Block =
  | { p: string }
  | { h: string }
  | { list: string[]; ordered?: boolean }
  | { code: string; lang?: 'ts' | 'text' }
  | { table: { head: string[]; rows: string[][] } }
  | { callout: string; tone?: 'note' | 'warn' | 'example' };

export interface Question {
  q: string;
  /** 3 or 4 options. Exactly one is right. */
  options: string[];
  /** Index into options. */
  answer: number;
  /** Why the answer is right, and why the tempting wrong one is wrong. One to three sentences. */
  explain: string;
}

export type Part = 'Why' | 'Core concepts' | 'In code' | 'Conventions' | 'Examples' | 'Running loops';

export interface Lesson {
  /** URL slug, e.g. `findings`. */
  id: string;
  part: Part;
  title: string;
  /** One sentence, shown in the lesson list. */
  summary: string;
  body: Block[];
  widget?: WidgetId;
  /** Where the widget goes: after this many body blocks. Defaults to the end of the body. */
  widgetAfter?: number;
  /** 2–4 questions. */
  quiz: Question[];
  /** The simulation that shows this lesson in action, if any. */
  simulation?: SimulationId;
}

export type SimulationId = 'experiment' | 'code-review' | 'review-loop' | 'migration' | 'on-call';
