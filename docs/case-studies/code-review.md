# Code review

An agent takes a code change from "sent for review" to "submitted" over a few days. It does the chores of review for the change's owner: it answers comments, adds reviewers, reruns checks and rebases.

## The job

An engineer writes a change and sends it for review. Before it can merge, the review system has a list of requirements. A reviewer must approve it. An owner of each directory it touches must approve it. Each language in it may need its own approval. The required checks must pass, and the change must merge cleanly with the target branch.

Meeting those requirements takes days of small chores:
- answering comments, and fixing nits and bugs;
- finding an owner for a directory when nobody on the change owns it;
- chasing a reviewer who has gone quiet;
- rerunning a flaky check;
- rebasing when the branch moves.

The agent does this work for the change's owner. It posts as itself, on their behalf, and leaves decisions that belong to the owner to the owner.

## What makes it hard

- **Many requirements, each with its own state.** The rules also differ from one review system to another.
- **It runs on people's time.** Reviewers answer during working hours, take days, and go out of office.
- **Comments need different responses.** A nit needs a code change. A question needs an answer. A design question needs the owner. Some suggestions are wrong and need pushback, which the owner should approve.
- **Progress can reset.** Some review systems clear approvals on a new patchset. The branch moves and causes a conflict that a rebase can't fix.

## How the loop sees the work

One rule shapes the whole loop: **every submit requirement that isn't met is a finding, and anything already in progress that will meet it is a blocker.** A clean frame then means every requirement is met, so the only step forward is to submit.

**Goal:** the change is submitted, by the agent or by a person.

**What it reads, every tick:** the change as the review system shows it, including:
- its patchsets, reviewers and whose turn it is;
- its comment threads and check results;
- whether it merges cleanly;
- the submit requirements themselves.

**Findings:**

| Finding | Example id |
| --- | --- |
| A thread whose latest message needs a response | `thread:t3@m7` |
| An approval that submitting still needs | `owners:web/`, `language:go`, `review` |
| A required check that is failing or still running | `check:unit-tests` |
| The change doesn't merge with the target branch | `conflict` |

**Blockers,** each covering only its own finding:
- a draft reply waiting for the owner;
- a question the agent put to the owner;
- a reviewer who can grant a missing approval and isn't away;
- a check that is still running.

## What the architecture gives you here

- **Done means what the review system says.** The loop reads the submit requirements instead of working out ownership itself. Porting it to another review system means mapping fields, not rewriting logic.
- **Waiting and acting are clearly separated.** If someone on the change can grant the owner approval, the finding is blocked and the loop waits. If nobody can, the finding is open and the loop adds a reviewer. Nobody has to write a special case for either.
- **A reviewer who never comes gets noticed.** A finding ages only while it is the reviewer's turn. After two days the loop escalates: it tags the owner, who can swap the reviewer.
- **Judgment is separate from policy.** An agent decides what kind of comment each message is, once per message, and the answer is memoized. A table that the team can read and tune decides the response.
- **Work is batched.** One new patchset addresses every comment marked for a fix, every real check failure, and any conflict a rebase can't solve.
- **Resets need no special handling.** When approvals are cleared, they are findings again, and the loop waits for them. A loop started 30 hours late reads where things stand and reaches the same result.

One caution. Each follow-up message is a new finding, so attempts and age start over with every reply. An endless back-and-forth on one thread never escalates by itself. A limit on messages per thread closes that gap.

## The code

The spec in `src/scenarios/code-review.ts` is short, because each part is a named function that can be tested on its own:

<!-- source: src/scenarios/code-review.ts#review-spec -->
```ts
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
```

Findings are every submit requirement that isn't met. Blockers are whatever is already on its way to meeting one:

<!-- source: src/scenarios/code-review.ts#review-findings -->
```ts
/** Everything wrong with the change that the agent should drive to resolution. */
export function findingsIn(c: ChangeView): ReviewFinding[] {
  return [
    ...c.threads.filter(awaitsUs(c)).map(threadFinding),
    ...c.requirements.filter((r) => !r.satisfied).map(requirementFinding),
    ...c.checks.filter((k) => k.required && k.state !== 'passed').map(checkFinding),
    ...(c.mergeable.ok ? [] : [conflictFinding(c.mergeable)]),
  ];
}
```

<!-- source: src/scenarios/code-review.ts#review-blockers -->
```ts
/** Work the world shows is already in hand. Nothing here holds the whole loop. */
export function blockersIn(c: ChangeView): Blocker[] {
  return [
    ...c.threads.flatMap(waitingOnOwner(c)),
    ...c.requirements.flatMap(assignedReviewer(c)),
    ...c.checks.filter((k) => k.required && k.state === 'running').map(runningCheck),
  ];
}
```

The agent only classifies each comment. This table, which a team can tune, decides what to do about it:

<!-- source: src/scenarios/code-review.ts#review-policy -->
```ts
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
```

`respond` turns each open finding into an action, with the attempt number in every key. Everything that needs a code change goes into one new patchset:

<!-- source: src/scenarios/code-review.ts#review-respond -->
```ts
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
```

## In the simulation

| Variant | What to watch |
| --- | --- |
| A typical review | Three approvals needed; a missing owner added; comments fixed, answered, drafted or put to the owner; a flaky check rerun; a rebase; then submit |
| Started late | The same result, starting 30 hours in |
| A reviewer who never comes | Two days of waiting, then the owner is tagged and swaps the reviewer |
| Votes that reset | A conflict fix clears an approval, and the loop waits for it again |
| A check that won't pass | Three attempts, then the owner fixes it |
| Lost drafts | Drafts that never appear are retried under new keys, then the thread goes to the owner |
