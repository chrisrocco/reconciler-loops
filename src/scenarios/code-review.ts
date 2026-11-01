/**
 * Code review (days): an agent drives a change to submitted, acting for its owner.
 *
 * One rule shapes the loop: every submit requirement that isn't met is a FINDING, and anything
 * already in progress that will meet it is a BLOCKER. A reviewer waiting on us, an approval nobody
 * assigned can grant, a failing or running check, a merge conflict: each is a finding. A draft or a
 * question with the owner, a reviewer who can grant the approval, a check that is still running:
 * each covers its finding. A clean frame therefore means every requirement is met, and the only
 * forward step is submit.
 *
 * The loop reads requirements from the review system rather than working out ownership itself,
 * so porting it to another review system is a matter of mapping fields, not logic.
 */
import type { Blocker, Budget, EscalateAction, Finding, Frame, ReconcilerSpec } from '../core/types.js';
import { escalation } from '../core/reconcile.js';
import { DAY, HOUR, MIN } from '../core/time.js';

// ───────────────────────────── the world, as the review system shows it ─────────────────────────────

/** The agent's account in the review system. It posts as itself, on the owner's behalf. */
export const AGENT = 'review-agent';

export interface ChangeView {
  id: string;
  owner: string;
  status: 'open' | 'submitted' | 'abandoned';
  patchset: number;
  reviewers: Reviewer[];
  /** Whose turn it is (the attention set). */
  attention: string[];
  /** People who are out of office, as the review system shows them. */
  away: string[];
  /** What submit still needs, as the review system computes it. */
  requirements: Requirement[];
  threads: Thread[];
  checks: Check[];
  mergeable: Mergeable;
}

export interface Reviewer {
  user: string;
  kind: 'person' | 'analyzer';
  addedAt: number;
  /** When it last became their turn; undefined while it isn't. */
  turnSince?: number;
  /** Out of office, as the review system shows it. */
  away?: boolean;
}

export interface Requirement {
  /** `review`, `owners:<path>`, `language:<lang>`. */
  id: string;
  summary: string;
  satisfied: boolean;
  /** Who could satisfy it, as the review system computes it. */
  eligible: string[];
}

export interface Message { id: string; author: string; body: string; at: number; draft?: boolean }

export interface Thread {
  id: string;
  /** `path:line`, or undefined for a comment on the whole change. */
  location?: string;
  origin: 'person' | 'analyzer';
  resolved: boolean;
  messages: Message[];
}

export interface Check {
  name: string;
  required: boolean;
  state: 'running' | 'passed' | 'failed';
  patchset: number;
  startedAt: number;
  /** Runs on the current patchset, this one included. */
  runs: number;
  /** The check system's own signal that this failure looks flaky. */
  likelyFlaky: boolean;
}

export type Mergeable =
  | { ok: true }
  /** `autoRebase`: the review system says a plain rebase onto the new head would apply cleanly. */
  | { ok: false; targetHead: string; autoRebase: boolean };

// ───────────────────────────── findings, judgments, actions ─────────────────────────────

export type ReviewFinding =
  | Finding<'thread', Thread>
  | Finding<'requirement', Requirement>
  | Finding<'check', Check>
  | Finding<'conflict', Extract<Mergeable, { ok: false }>>;

/** What kind of comment a thread is: the agent's judgment, made once per message. */
export type Category =
  | 'fix' // a nit, a bug, or a suggestion worth taking
  | 'question' // needs an answer, not a code change
  | 'disagree' // the agent would push back; the owner should approve that
  | 'decision' // design or scope: the owner decides
  | 'fyi' // praise, or a note that needs only an acknowledgement
  | 'not-useful'; // an analyzer finding that doesn't apply here

export interface Judgment { category: Category; rationale: string }

// #region review-policy
/** What the policy does with each category. A team tunes this, like permission settings. */
export type Response = { act: 'fix' } | { act: 'reply'; send: 'post' | 'draft' } | { act: 'ask-owner' };
export type ResponsePolicy = Record<Category, Response>;

export const DEFAULT_POLICY: ResponsePolicy = {
  fix: { act: 'fix' },
  question: { act: 'reply', send: 'post' },
  disagree: { act: 'reply', send: 'draft' },
  decision: { act: 'ask-owner' },
  fyi: { act: 'reply', send: 'post' },
  'not-useful': { act: 'reply', send: 'post' },
};
// #endregion

export type ReviewAction =
  | { key: string; kind: 'revise'; targets: string[]; threads: Thread[]; checks: string[]; conflict: boolean }
  | { key: string; kind: 'reply'; targets: string[]; thread: Thread; category: Category; draft: boolean; deadlineMs?: number }
  | { key: string; kind: 'add-reviewer'; user: string; requirement: string }
  | { key: string; kind: 'rerun'; targets: string[]; check: string; deadlineMs: number }
  | { key: string; kind: 'rebase'; targets: string[]; onto: string; deadlineMs: number }
  | { key: string; kind: 'submit' }
  | EscalateAction;

// ───────────────────────────── the systems it acts on ─────────────────────────────

export interface CodeReviewActivities {
  getChange(change: string): Promise<ChangeView>;
  /** Agent: what kind of comment is this thread's latest message? */
  judge(change: string, thread: Thread): Promise<Judgment>;
  /** Agent: one new patchset that addresses these threads, fixes these checks and resolves the conflict. Replies "Done" on each thread. */
  revise(req: { change: string; key: string; threads: Thread[]; checks: string[]; conflict: boolean }): Promise<void>;
  /** Agent: write and post (or leave as a draft for the owner) the reply this category calls for. */
  reply(req: { change: string; key: string; thread: Thread; category: Category; draft: boolean }): Promise<void>;
  addReviewer(change: string, user: string, key: string): Promise<void>;
  rerunCheck(change: string, check: string, key: string): Promise<void>;
  rebase(change: string, onto: string, key: string): Promise<void>;
  /**
   * Escalate: put the owner in the attention set with a comment that @-mentions them, says why and
   * ends `(re <finding id>)`. On the finding's thread if it has one, else a comment on the change.
   */
  tagOwner(req: { change: string; key: string; finding: string; threadId?: string; reason: string }): Promise<void>;
  submit(change: string, key: string): Promise<void>;
}

export interface CodeReviewInput { change: string; policy?: ResponsePolicy }

export const CODE_REVIEW_BUDGET: Budget = {
  maxDurationMs: 30 * DAY,
  maxAttemptsPerFinding: 3,
  /** A reviewer who hasn't taken their turn in two days gets the owner involved. */
  maxFindingAgeMs: 2 * DAY,
  escalationDeadlineMs: HOUR,
};

type ReviewFrame = Frame<ChangeView, ReviewFinding, Judgment>;

// ───────────────────────────── the loop ─────────────────────────────

// #region review-spec
export function codeReviewLoop(
  acts: CodeReviewActivities,
  input: CodeReviewInput,
): ReconcilerSpec<ChangeView, ReviewFinding, ReviewAction, Judgment> {
  const policy = input.policy ?? DEFAULT_POLICY;
  return {
    name: `code-review:${input.change}`,
    budget: CODE_REVIEW_BUDGET,

    // Look: one read of the change, then pure functions decide what's wrong and what's in hand.
    async observe() {
      const change = await acts.getChange(input.change);
      return { world: change, findings: findingsIn(change), blockers: blockersIn(change) };
    },

    // Judge each open thread once per message: what kind of comment is it?
    async assess(open, { memo }) {
      return judgeThreads(open, (t, id) => memo.get(`judge:${id}`, () => acts.judge(input.change, t)));
    },

    // Goal: the change is submitted, by the agent or by a person.
    done: ({ world }) => (world.status === 'submitted' ? `submitted at patchset ${world.patchset}` : world.status === 'abandoned' ? 'abandoned by its owner' : undefined),

    // Decide: answer what's open, then submit once every requirement is met.
    plan(frame) {
      return { actions: [...respond(frame, policy), ...moveForward(frame)], wake: wakeFor(frame) };
    },

    // Act: one idempotent effect per action, escalations included.
    act: (action, frame) => perform(acts, input.change, action, frame),
  };
}
// #endregion

// ───────────────────────────── what the loop sees ─────────────────────────────

// #region review-findings
/** Everything wrong with the change that the agent should drive to resolution. */
export function findingsIn(c: ChangeView): ReviewFinding[] {
  return [
    ...c.threads.filter(awaitsUs(c)).map(threadFinding),
    ...c.requirements.filter((r) => !r.satisfied).map(requirementFinding),
    ...c.checks.filter((k) => k.required && k.state !== 'passed').map(checkFinding),
    ...(c.mergeable.ok ? [] : [conflictFinding(c.mergeable)]),
  ];
}
// #endregion

// #region review-blockers
/** Work the world shows is already in hand. Nothing here holds the whole loop. */
export function blockersIn(c: ChangeView): Blocker[] {
  return [
    ...c.threads.flatMap(waitingOnOwner(c)),
    ...c.requirements.flatMap(assignedReviewer(c)),
    ...c.checks.filter((k) => k.required && k.state === 'running').map(runningCheck),
  ];
}
// #endregion

/** A thread waits on us when its latest published message is from a reviewer (a person or an analyzer). */
export const awaitsUs = (c: ChangeView) => (t: Thread) => {
  const last = latestPublished(t);
  return !t.resolved && !!last && last.author !== AGENT && last.author !== c.owner;
};

/** A new message from the reviewer needs a new answer, so the latest message is part of the id. */
export const threadFindingId = (t: Thread) => `thread:${t.id}@${latestFromReviewer(t)?.id}`;

const threadFinding = (t: Thread): ReviewFinding => ({
  id: threadFindingId(t), kind: 'thread', severity: 'blocking', summary: latestPublished(t)!.body, data: t,
});

/** The requirement's own id (`owners:search/`): the same until it is granted. */
const requirementFinding = (r: Requirement): ReviewFinding => ({
  id: r.id, kind: 'requirement', severity: 'blocking', summary: r.summary, data: r,
});

/**
 * No patchset in the id: a check that keeps failing across fix attempts counts toward one set of
 * attempts, and is escalated. A running check is a finding too ("not passed yet"), blocked by the run.
 */
const checkFinding = (k: Check): ReviewFinding => ({
  id: `check:${k.name}`, kind: 'check', severity: 'blocking', summary: `${k.name} ${k.state}`, data: k,
});

const conflictFinding = (m: Extract<Mergeable, { ok: false }>): ReviewFinding => ({
  id: 'conflict', kind: 'conflict', severity: 'blocking', summary: `doesn't merge with ${m.targetHead}`, data: m,
});

/**
 * A draft reply waiting for the owner covers its thread. So does a question the agent put to the
 * owner, which covers the finding the tag names (`(re <finding id>)`): it's in hand while the
 * owner is in the attention set and hasn't answered on that thread since.
 */
export const waitingOnOwner = (c: ChangeView) => (t: Thread): Blocker[] => {
  if (t.messages.some((m) => m.draft && m.author === AGENT))
    return [{ id: `draft:${t.id}`, kind: 'owner-approval', on: [threadFindingId(t)], scope: 'finding', summary: 'draft reply awaiting the owner' }];
  const tag = [...t.messages].reverse().find((m) => !m.draft && m.author === AGENT && m.body.includes(`@${c.owner}`));
  const about = tag?.body.match(/(re ([^)]+))s*$/)?.[1];
  const answered = tag && t.messages.some((m) => m.author === c.owner && m.at > tag.at);
  if (tag && about && !answered && c.attention.includes(c.owner))
    return [{ id: `owner:${t.id}`, kind: 'owner-decision', on: [about], scope: 'finding', summary: `asked @${c.owner}`, since: tag.at }];
  return [];
};

/**
 * Someone who can grant the requirement is on the change and present: wait for them. While it's
 * their turn the blocker ages, so a reviewer who never responds is eventually escalated.
 */
export const assignedReviewer = (c: ChangeView) => (r: Requirement): Blocker[] =>
  r.satisfied ? [] : c.reviewers
    .filter((rv) => rv.kind === 'person' && !rv.away && r.eligible.includes(rv.user))
    .map((rv) => ({ id: `reviewer:${rv.user}:${r.id}`, kind: 'reviewer', on: [r.id], scope: 'finding' as const, summary: `${rv.user} can grant ${r.id}`, since: rv.turnSince }));

const runningCheck = (k: Check): Blocker => ({
  id: `running:${k.name}`, kind: 'check-run', on: [`check:${k.name}`], scope: 'finding', summary: `${k.name} running`, since: k.startedAt,
});

// ───────────────────────────── judgment ─────────────────────────────

/** One judgment per open thread, keyed by its finding id so each message is judged once. */
export async function judgeThreads(open: ReviewFinding[], judge: (t: Thread, id: string) => Promise<Judgment>) {
  const out: Record<string, Judgment> = {};
  for (const f of open) if (f.kind === 'thread') out[f.id] = await judge(f.data, f.id);
  return out;
}

// ───────────────────────────── what the loop does about it ─────────────────────────────

// #region review-respond
/**
 * The response to each open finding, with the attempt number in every key. Everything that needs
 * a code change (threads to fix, failing checks, a conflict a rebase can't solve) goes into ONE
 * revision: these are independent items handled together, so batching them in plan is right.
 */
export function respond(f: ReviewFrame, policy: ResponsePolicy): ReviewAction[] {
  const actions: ReviewAction[] = [];
  const toRevise: ReviewFinding[] = [];
  for (const x of f.open) {
    const n = (f.attempts[x.id] ?? 0) + 1;
    if (x.kind === 'thread') {
      const judged = f.assessments[x.id]!;
      const how = policy[judged.category];
      if (how.act === 'fix') toRevise.push(x);
      else if (how.act === 'ask-owner') actions.push(askOwner(f, x, judged.rationale));
      else actions.push({ key: `reply:${x.id}:${n}`, kind: 'reply', targets: [x.id], thread: x.data, category: judged.category, draft: how.send === 'draft', deadlineMs: how.send === 'draft' ? HOUR : undefined });
    }
    if (x.kind === 'requirement') {
      const who = pickReviewer(x.data, f.world);
      actions.push(who
        // No targets: adding someone isn't an attempt at the finding, and it mustn't start its age.
        // The requirement ages only while it's the new reviewer's turn (see assignedReviewer).
        ? { key: `add-reviewer:${x.id}:${who}`, kind: 'add-reviewer', user: who, requirement: x.id }
        : askOwner(f, x, `nobody available can grant ${x.data.summary}`));
    }
    if (x.kind === 'check') {
      // The check system thinks it's flaky and it has only run once on this patchset: rerun it. Otherwise fix it.
      if (x.data.state === 'failed' && x.data.likelyFlaky && x.data.runs < 2)
        actions.push({ key: `rerun:${x.id}@ps${x.data.patchset}`, kind: 'rerun', targets: [x.id], check: x.data.name, deadlineMs: HOUR });
      else if (x.data.state === 'failed') toRevise.push(x);
    }
    if (x.kind === 'conflict') {
      if (x.data.autoRebase) actions.push({ key: `rebase:${x.id}:${n}@${x.data.targetHead}`, kind: 'rebase', targets: [x.id], onto: x.data.targetHead, deadlineMs: HOUR });
      else toRevise.push(x);
    }
  }
  if (toRevise.length) actions.unshift(revision(f, toRevise));
  return actions;
}
// #endregion

/** One new patchset for every finding that needs a code change. Its key names them all, at their highest attempt. */
function revision(f: ReviewFrame, xs: ReviewFinding[]): ReviewAction {
  const ids = xs.map((x) => x.id).sort();
  const n = Math.max(...ids.map((id) => (f.attempts[id] ?? 0) + 1));
  return {
    key: `revise:${ids.join(',')}:${n}`, kind: 'revise', targets: ids,
    threads: xs.flatMap((x) => (x.kind === 'thread' ? [x.data] : [])),
    checks: xs.flatMap((x) => (x.kind === 'check' ? [x.data.name] : [])),
    conflict: xs.some((x) => x.kind === 'conflict'),
  };
}

/** The same escalation the loop files on its own, used when the policy or a dead end says the owner decides. */
const askOwner = (f: ReviewFrame, x: ReviewFinding, reason: string) => escalation({ finding: x, reason }, f, CODE_REVIEW_BUDGET);

/** A pure choice: the first eligible person who is present and not already on the change. */
export function pickReviewer(r: Requirement, c: ChangeView): string | undefined {
  const on = new Set(c.reviewers.map((rv) => rv.user));
  return r.eligible.find((u) => u !== c.owner && u !== AGENT && !on.has(u) && !c.away.includes(u));
}

/** Every requirement met (that is what a clean frame means here): submit this patchset. */
export function moveForward(f: ReviewFrame): ReviewAction[] {
  const clean = !f.findings.length && !f.blockers.length && !f.claimed.length;
  return clean && f.world.status === 'open' ? [{ key: `submit:ps${f.world.patchset}`, kind: 'submit' }] : [];
}

/** Checks finish in minutes; people take hours, and the review system hints us when anything changes. */
export function wakeFor(f: ReviewFrame) {
  if (f.claimed.length) return { afterMs: 5 * MIN, signals: ['change-updated'] };
  const running = f.world.checks.some((k) => k.state === 'running');
  return { afterMs: running ? 15 * MIN : 2 * HOUR, signals: ['change-updated'] };
}

// ───────────────────────────── acting ─────────────────────────────

/** One effect per action, each idempotent on its key. */
export async function perform(acts: CodeReviewActivities, change: string, a: ReviewAction, f: ReviewFrame): Promise<void> {
  const key = `${change}/${a.key}`;
  switch (a.kind) {
    case 'revise': return acts.revise({ change, key, threads: a.threads, checks: a.checks, conflict: a.conflict });
    case 'reply': return acts.reply({ change, key, thread: a.thread, category: a.category, draft: a.draft });
    case 'add-reviewer': return acts.addReviewer(change, a.user, key);
    case 'rerun': return acts.rerunCheck(change, a.check, key);
    case 'rebase': return acts.rebase(change, a.onto, key);
    case 'submit': return acts.submit(change, key);
    case 'escalate': {
      const finding = f.findings.find((x) => x.id === a.finding);
      return acts.tagOwner({ change, key, finding: a.finding, threadId: finding?.kind === 'thread' ? finding.data.id : undefined, reason: a.reason });
    }
  }
}

// ───────────────────────────── small helpers ─────────────────────────────

const latestPublished = (t: Thread) => [...t.messages].reverse().find((m) => !m.draft);
const latestFromReviewer = (t: Thread) => [...t.messages].reverse().find((m) => !m.draft && m.author !== AGENT);
