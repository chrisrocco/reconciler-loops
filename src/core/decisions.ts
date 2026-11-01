/**
 * The shared decision component, as the loop sees it: questions for people (use this
 * experiment or create one? approve these fields?) and their answers. A loop reads
 * answers in `observe`, so `plan` stays pure; an unanswered question is a blocker that
 * holds the loop. Answers arrive by signal (in Temporal, `answerSignal`), never by Update.
 */
export interface Question<C> {
  /** Stable: the same question gets the same key every tick, and the answer is stored under it. */
  key: string;
  /** The kind of question, e.g. `mount-or-create`. Auto-approval is set per kind. */
  kind: string;
  question: string;
  options: C[];
  /** The agent's suggestion. A kind set to auto-approve takes it without asking. */
  suggested?: C;
}

export interface Decisions {
  /**
   * The answer to a question, asking it if needed; undefined while unanswered.
   * Synchronous: answers are already in workflow state, so reading one needs no activity.
   */
  get<C>(q: Question<C>): C | undefined;
}

/** Which kinds of question the agent may answer itself with its own suggestion. */
export interface DecisionPolicy { autoApprove?: string[] | 'all' }

/** Every question is answered at once with the suggestion, or the first option. */
export const autoApprove: Decisions = { get: (q) => q.suggested ?? q.options[0] };

/**
 * Decisions held in workflow state: answers are set by whatever receives the answer signal
 * (or by a test). Kinds in the policy are answered with the suggestion without asking.
 */
export class SignalDecisions implements Decisions {
  /** Questions asked and not yet answered, for whatever shows them to people. */
  readonly asked = new Map<string, Question<unknown>>();
  private readonly answers: Map<string, unknown>;

  constructor(private policy: DecisionPolicy = {}, answers: Record<string, unknown> = {}) {
    this.answers = new Map(Object.entries(answers));
  }

  get<C>(q: Question<C>): C | undefined {
    if (this.answers.has(q.key)) return this.answers.get(q.key) as C;
    const auto = this.policy.autoApprove === 'all' || this.policy.autoApprove?.includes(q.kind);
    if (auto && (q.suggested !== undefined || q.options.length)) return q.suggested ?? q.options[0];
    this.asked.set(q.key, q);
    return undefined;
  }

  answer(key: string, value: unknown) {
    this.answers.set(key, value);
    this.asked.delete(key);
  }

  /** Answers to carry across continue-as-new, so nobody is asked twice. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.answers);
  }
}
