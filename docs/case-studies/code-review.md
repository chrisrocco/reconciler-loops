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

## In the simulation

| Variant | What to watch |
| --- | --- |
| A typical review | Three approvals needed; a missing owner added; comments fixed, answered, drafted or put to the owner; a flaky check rerun; a rebase; then submit |
| Started late | The same result, starting 30 hours in |
| A reviewer who never comes | Two days of waiting, then the owner is tagged and swaps the reviewer |
| Votes that reset | A conflict fix clears an approval, and the loop waits for it again |
| A check that won't pass | Three attempts, then the owner fixes it |
| Lost drafts | Drafts that never appear are retried under new keys, then the thread goes to the owner |
