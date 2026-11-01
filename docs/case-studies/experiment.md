# Experiment ramp

An agent turns a new feature on for everyone, a stage at a time, over two weeks or more. It watches for harm, and when something regresses it rolls back, investigates and ships a fix.

## The job

A team ships a change behind a feature flag and wants to turn it on for all users without hurting anyone. The usual practice is a ramp. Turn it on for 1% of traffic and wait a day. Look at the guardrail metrics: latency, error rate, revenue per user. If they hold, go to 5% and wait two days, then 25%, 50% and 100%. A standard ramp takes about two weeks when nothing goes wrong.

Something often does go wrong. A guardrail drops at 25%. Someone has to roll the ramp back, work out the cause, get a fix through code review and the release process, wait for it to reach production, and then start ramping again. Today a person does all of this by hand: they check dashboards every morning, file bugs and chase fixes.

## What makes it hard

- **It runs for weeks.** Over that time, workers restart, the workflow engine is upgraded, and the process running the ramp will crash at some point.
- **The signals are noisy.** Metrics come with confidence intervals and arrive late. Sometimes the metrics pipeline stalls. Guardrails that fail together usually share one cause.
- **Fixes are slow.** A fix needs review, then a release cut, then a rollout in waves. Days pass between "fixed" and "fixed in production".
- **People act at the same time.** An engineer ships their own fix and closes the bug by hand. On-call rolls the experiment back from a console. The agent has to cope with the world changing under it.
- **Some harm shows up late.** A novelty effect can hide a revenue drop for a week or more. Only a long holdback catches it.

## How the loop sees the work

**Goal:** the experiment is at its final stage, has soaked there, and every guardrail passes.

**What it reads, every tick:** the experiment service (which stage, and since when), the guardrail metrics, the bug tracker, the deploy system, the pager, and any question it has put to the owner.

**Findings:**

| Finding | What it means |
| --- | --- |
| `unmounted` | The flag has no experiment yet. The loop asks the owner whether to manage an existing one or create one |
| `regression:s<stage>` | One or more guardrails are failing. It is one finding for all of them, because metrics that move together usually move for one cause |

**Blockers,** each of which holds the whole ramp: an open bug, a fix that hasn't reached production, an open page, and a question still waiting for an answer.

**Moving forward:** the loop advances one stage only on a clean frame: no findings, no blockers, every guardrail passing, and the stage has soaked long enough.

**Responding to a regression:** roll back if it's severe, then have an agent triage it. The triage picks one of three routes: a quick fix, a bug with a child investigation loop, or a page to on-call.

## What the architecture gives you here

- **Crashes are routine.** Everything the loop files is labeled with the flag. A fresh run with no memory reads the bug tracker and deploy system, finds its own bugs and fixes, and carries on where the old run stopped.
- **People can step in.** When a person closes the bug or rolls the ramp back, the loop sees it on its next tick and plans from there. Nobody has to tell the agent.
- **Investigations nest without wiring.** An investigation is its own loop, working on its own bug. The ramp only sees an open bug, which is a blocker. There are no messages or callbacks between them, and a depth limit stops runaway recursion.
- **Slow fixes aren't fixed twice.** After the agent submits a fix, the regression is claimed until the deploy system shows the fix live. A rollout that takes three days doesn't look like a fix that was never made.
- **Thrashing is bounded.** The regression keeps its id through a rollback and a re-advance. Every failed fix counts against one set of attempts. After three, the loop escalates: it rolls back to stage 0 and pages on-call.
- **Policy is data.** The ramp is a list of stages and soak times. With several treatment arms, a regression holds only its own arm, and the other arms keep ramping.

The loop has to remember one thing the world doesn't record: which experiment on the flag it manages. It keeps that as a named fact. If the fact is lost, the loop asks the owner again rather than guessing.

## In the simulation

Every run happens in a realistic world: noisy metrics, flaky systems, agents that are sometimes wrong, reviews in working hours, daily release cuts and weekday rollouts. A seed picks one draw of that world, so the same scenario plays out differently from seed to seed while the loop's guarantees hold.

| Scenario | What to watch |
| --- | --- |
| Happy path | One stage per soak window, then done at 100% |
| Quick fix | The ramp is held while a fix reaches production |
| Recursive investigation | A child investigation that needs a grandchild to fix a prerequisite first |
| Correlated metrics | Three guardrails failing for one cause become one finding, one bug and one investigation |
| Crash and no-memory restart | A fresh run finds the bug the old run filed and repairs the missing investigation |
| Human closes the bug | The ramp moves on because the bug tracker says so |
| Thrash guard | Fixes that never help, escalated after three attempts, ending in a safe hold |
| Playbook escalation | No automated response exists, so the loop pages on-call and waits |
| Long-term holdback | A 1% holdback catches a revenue drop ten days in |
| Multi-arm A/B | Only the broken arm rolls back; the others keep ramping |
| Depth limit | The child escalates instead of recursing, and a person finishes the job |
