# Inline review loop

Before an agent sends a change to people, it reviews its own work. Reviewer agents comment, the author agent revises, and they repeat until the change is clean. This takes minutes, and it runs as one step inside the agent's larger workflow.

## The job

An agent has written a change. Before a person spends time on it, several reviewer agents each look at one dimension, such as correctness, tests or style, and leave comments. The author agent addresses all of the comments in one new revision. The reviewers look again. When nothing blocking is left, the change is mailed to people.

This is the shortest loop in the collection. It shows that the same primitive scales down to a task that takes minutes, and where the pattern stops paying for itself.

## What makes it hard

- **Fixes cause new problems.** Fixing a null dereference can leave a branch with no test. The next round has to catch that.
- **Some findings never go away.** The author may never manage to fix a security issue. Revising forever is not an answer.
- **Nobody is on call.** This loop runs inline, in the middle of another workflow, and there is nobody to page. Something has to decide when to stop.
- **Reviews cost money.** If the workflow crashes and resumes, it shouldn't pay for the same review twice.

## How the loop sees the work

**Goal:** the current revision has no blocking comments.

**What it reads, every tick:** the current revision, and each reviewer's comments on it.

**Findings:** each comment, with an id built from its dimension, location and issue, such as `correctness:auth.ts:42:null-deref`. The id stays the same across revisions, so the same problem keeps its attempt count.

**Blockers:** none. Nothing else is working on the change.

**Action:** one new revision that addresses every open finding.

**Stopping:** there are three ways out.

| Outcome | What happens |
| --- | --- |
| Clean | The change is mailed to people |
| A finding out of attempts | The finding is escalated. With nobody to page, the loop stops, and the caller hands the change to a person |
| Out of rounds | The plan says stop. The caller decides what to do next |

## What the architecture gives you here

- **Stable ids catch a stubborn finding.** A comment that comes back on every revision is the same finding with a rising attempt count. After three attempts it is escalated rather than retried forever.
- **Reviews are paid for once.** Each review is memoized by dimension and revision. A workflow that crashes and resumes reads the stored result instead of calling the reviewer again.
- **Stopping is part of the plan.** A round limit is the plan deciding to stop, not an error. Escalation in an inline loop means "stop and hand it to the caller", because there is nobody to wait for.
- **It embeds cleanly.** The loop is a function that returns an outcome. The larger workflow calls it like any other step and acts on the result.

This loop sits near the lower limit of where the pattern helps. With a person watching every step, a plain agent loop would do. The reconciler earns its place here because the review step is durable, resumable and capped, and because it is the same code as the loops that run for weeks.

## The code

The whole loop, from `src/scenarios/review-loop.ts`. The finding id leaves out the revision, so a comment that survives a revision is the same finding with one more attempt. `plan` stops the loop in two ways: a finding being escalated, or running out of rounds.

<!-- source: src/scenarios/review-loop.ts#inline-review -->
```ts
export function reviewLoopSpec(
  acts: ReviewActivities,
  input: ReviewInput,
): ReconcilerSpec<{ revision: number }, ReviewFinding, ReviewAction> {
  const { changeId, dimensions } = input;
  return {
    name: `review:${changeId}`,
    budget: { maxAttemptsPerFinding: input.maxAttemptsPerFinding ?? 3 },

    async observe({ memo }) {
      const revision = await acts.currentRevision(changeId);
      // Reviews are memoized per (dimension, revision): resuming never re-pays for a review.
      const batches = await Promise.all(
        dimensions.map((d) => memo.get(`review:${d}@r${revision}`, () => acts.review(d, changeId, revision))),
      );
      const findings = batches.flat().map<ReviewFinding>((c) => ({
        // Fingerprint ignores revision: an unfixed comment is the SAME finding next round.
        id: `${c.dimension}:${c.location}:${c.issue}`,
        kind: 'review-comment', severity: c.severity, summary: c.detail, data: c,
      }));
      return { world: { revision }, findings, blockers: [] };
    },

    done: (f) => (f.findings.some((x) => x.severity === 'blocking') ? undefined : `clean at r${f.world.revision}`),

    plan(f) {
      const stuck = f.escalating[0];
      if (stuck) return { actions: [], wake: { afterMs: 0 }, halt: { status: 'escalated', reason: `${stuck.finding.id}: ${stuck.reason}` } };
      const maxRounds = input.maxRounds ?? 6;
      if (f.tick >= maxRounds) return { actions: [], wake: { afterMs: 0 }, halt: { status: 'escalated', reason: `not clean after ${maxRounds} rounds` } };
      if (!f.open.length) return { actions: [], wake: { afterMs: 60_000 } };
      return {
        actions: [{
          key: `revise:r${f.world.revision}`, kind: 'revise',
          targets: f.open.map((x) => x.id), comments: f.open.map((x) => x.data),
        }],
        wake: { afterMs: 0 },
        note: `addressing ${f.open.length} finding(s) on r${f.world.revision}`,
      };
    },

    async act(a, f) {
      // An escalation needs no effect here: the loop stops, and the caller hands the change over.
      if (a.kind === 'revise') await acts.revise(changeId, f.world.revision, a.comments);
    },
  };
}
```

## In the simulation

| Variant | What to watch |
| --- | --- |
| Converges | Three reviewers find three problems; fixing one introduces a fourth, which round two catches; the change is mailed at revision 2 |
| A stubborn finding | An SQL injection the author never fixes is escalated after three attempts, and the loop stops |
| Out of rounds | A coverage gap that needs five revisions runs into a three-round limit |
