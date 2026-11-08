# Implementation playbook

How to build a reconciler loop into an existing project, in six phases, each with a gate. It is written for whoever does the work, a person or a coding agent, and it says which decisions belong to people.

## How to use this

Read the [guide](https://github.com/chrisrocco/reconciler-loops/blob/main/docs/reconciler-loops.md) first, or at least its core concepts, and the [certificate renewal example](https://github.com/chrisrocco/reconciler-loops/blob/main/examples/cert-renewal.ts), a complete loop in about 150 lines. This playbook assumes that vocabulary: the world, findings and their ids, actions and keys, the ledger, blockers, attempts and escalation.

Writing the loop itself is the small part. Projects go wrong in two other places:

- **Design questions nobody settled.** What "done" means, how to recognize the same problem twice, who else changes the same systems. Each one left open turns into a bug weeks into a run.
- **The read side.** If `observe` reads the world wrong, a correct `plan` makes wrong decisions with full confidence.

So the phases front-load both, and actions that change anything come last.

**Work in order, and respect the gates.** Each phase ends with a gate: something a person can check. Don't start a phase until the previous gate is met. If a later phase shows an earlier answer was wrong, go back and fix the answer in the design doc first, then the code.

**Stop and ask about these.** Some decisions are not the implementer's to make, however obvious the answer looks. Ask a person, and write the answer in the design doc:

- what the goal is, and what counts as done;
- which actions the loop may take on its own, and which need a person's approval;
- who receives escalations, and where;
- attempt limits, age limits, time budgets and caps on work in flight;
- what the safe hold does when the loop runs out of time or is told to stop;
- whether an existing workflow keeps running alongside the new loop, and on what share of the work.

**Keep a design doc in the target project.** Phases 1 and 2 fill it in, and later phases keep it current. A template is at the end of this page. Anything specific to the project, such as system names, endpoints and owners, goes there, not here.

## The phases at a glance

| Phase | What it produces | Gate |
| --- | --- | --- |
| 1. Survey | An inventory of state, systems and other actors | Every piece of state has an owner |
| 2. Design | Written answers to the design questions | A person signs off, after a walk-through of three scenarios on paper |
| 3. Read side | Typed reads, fixtures, fakes and contract tests | Every read is tested against real data, and a failed read is never mistaken for an empty one |
| 4. Plan and shadow | `plan`, its tests, and a loop running in production that takes no actions | No unexplained disagreements with reality over a full cycle of the work |
| 5. Actions | Actions turned on one at a time, least harmful first | Each action runs clean at its scope before the next one starts |
| 6. Cutover | The old system off, and a runbook | Nothing left that only the old system knows |

## Phase 1: Survey what exists

Before designing anything, write down what is already there. The goal is a list of every fact the work depends on, and the system that owns each one.

**If you are replacing an existing workflow,** read it end to end and list:

- **Every value it keeps between steps,** such as an issue id, a PR number, a retry counter, a "waiting for deploy" flag or a timestamp. These are the workflow's private copy of the truth, and each one can go stale.
- **Every call it makes,** split into reads and writes.
- **Every wait:** sleeps, polls, signals it blocks on.
- **Every branch on stored state,** such as `if (state === 'waiting')`.

Then, for each stored value, fill in a row:

| Stored value | Which system owns that fact | Can the loop read it there? | Becomes |
| --- | --- | --- | --- |
| PR number | The code host | Yes, by a label on the PR | A read |
| Retry counter | Nobody else | No | The ledger's attempt count |
| Experiment id | The experiment service, but nothing links it to this workflow | Only by searching | A remembered fact |
| "Waiting for deploy" | The deploy system | Yes: which release contains the commit | A read, and a blocker |

Every value ends up as one of four things: **a read** from the system that owns it (most of them), **an attempt count** in the ledger, **a remembered fact** (rare, and it must be safe to lose), or **dropped**, because the loop no longer needs it.

**For each system the work touches,** record:

- the reads it offers, and how fresh their data is;
- the writes it offers, and how long until a write shows up in a read;
- whether a write can carry a marker the loop can search for later, such as a label, a tag, a branch name or a line in a description;
- rate limits, quotas, authentication, and how it fails: errors, timeouts, partial results.

**List the other actors.** Who else changes these systems? People fixing things by hand, other bots, other workflows, scheduled jobs. The loop has to read their changes, never fight them.

**Collect past incidents.** Stuck runs, duplicate actions, work that was declared done and wasn't. Each becomes a test scenario in phase 4.

**Gate:** the inventory is in the design doc, and every stored value has an owner and a fate.

## Phase 2: Settle the design

Answer these questions in order. Each one depends on the answers before it.

**1. The unit of work and the goal.** What does one loop own: one item, such as one error or one experiment, or a fleet that never finishes? Large jobs often need both, as in the [migration example](https://github.com/chrisrocco/reconciler-loops/blob/main/docs/case-studies/migration.md): a campaign loop that picks what to work on, and a loop per item with a goal of its own.

Write the goal as a check on what the loop observes, not on what it did. "Fix merged" is something the loop did. "Error gone from the fixed release" is something it observes. If they differ, the goal is the second one.

**2. Findings and their ids.** List each kind of finding, and the id scheme for each. An id must stay the same while the problem is the same, and change when the problem needs a new response. Then try to break it: write down what changes in the world over a long run, such as names, versions, line numbers, group ids or timestamps, and check that none of it leaks into the id. Drifting ids are the most common design bug: the loop loses its attempt counts, files duplicates and never escalates. Keep the examples you write here, because they become tests in phase 3.

Size each finding to its response: one response, one finding. Correlated symptoms that one investigation will handle are one finding.

**3. Responses and authority.** For each kind of finding, what does the loop do about it? Separate the safety action the loop takes at once (mitigate) from the lasting work it hands off (delegate), such as filing an issue. For each action, decide whether the loop may take it alone or must ask a person first.

**4. How the loop finds its own work.** For every action that creates something lasting, decide the marker that lets a fresh run find it: a label naming the finding, a branch name, a line in a commit message. For each action, set a deadline: how long it usually takes to show up in a read, plus a margin.

**5. Blockers.** What in the world means "this is already being handled, wait"? An open issue, a PR under review, a release rolling out. Each blocker names the finding it covers.

**6. Agents.** List every agent call. Give each one a narrow job: either a question answered with one of a few typed options, or one bounded piece of work, such as writing a fix, that something else verifies. For each, say how its result is checked. No agent chooses the next step or builds a key: the agent describes, the code decides.

**7. Limits and escalation.** Attempt limit, age limit, time budget and caps on work in flight. Who receives an escalation, through what channel, and what it contains. What the safe hold does.

**8. Remembered facts.** List each fact the loop must keep because the world can't show it. For each, why not, and what happens if it is lost. Aim for none, and accept one or two.

**9. Library or hand-rolled.** Use this repository's library, or write your own core. If you write your own, check every row of the guide's [hand-rolled table](https://github.com/chrisrocco/reconciler-loops/blob/main/docs/reconciler-loops.md#hand-rolled-or-library). Each row fails quietly, days into a run.

**Walk through three scenarios on paper** before anyone signs off. For each, write the frame and the plan's actions tick by tick:

- the ordinary path, from start to done;
- a person changing something mid-run, such as fixing the problem by hand or reverting the loop's change;
- a fix that doesn't work, through to escalation.

These walk-throughs find most design gaps, and they become scenario tests in phase 4.

**Gate:** the design doc answers every question, the walk-throughs are written down, and a person has signed off on the decisions listed under "Stop and ask".

## Phase 3: Build the read side

This is where most of the effort belongs. Build it before `plan`, and test it harder than anything else.

### Rules for every read

- **One function per read, with a typed result.** Return only what the frame needs, such as a count and a verdict rather than raw buckets or full threads. On a durable workflow engine every result is stored in history, and large reads fill it in a few ticks.
- **A failed read means "unknown", never "absent".** If the query times out, `observe` must not report zero errors, or the loop decides it is done. Make "unknown" its own value in the result type, so the compiler forces every caller to handle it. When a read is unknown, the loop holds: no moving forward, no new response based on missing data, and `done` is false. If a read stays unknown for long, that is a finding of its own, escalated like any other.
- **Know when you have everything.** Follow pagination to the end, and treat a truncated result as unknown. A list cut off at 100 items, read as complete, silently loses findings.
- **Know each source's lag.** A read right after a write may not show it. That lag is what deadlines are for, so measure it here and use it to set them.
- **Split each read in two:** a fetch that returns raw data, and a pure function that turns raw data into findings and blockers. All the interesting logic goes in the pure part.
- **Make every write safe to repeat with the same key.** Before creating anything, search the receiving system for an object carrying that key or marker. The search may lag the create, so creates that can't be found right away need the receiving system's own idempotency token, if it has one.

### Tests

- **Record fixtures from the real systems,** with personal data removed. Include the awkward cases: errors, timeouts, empty results, the last page, malformed records, and data from just before and after a change.
- **Write contract tests that run against both sides:** the real client replaying fixtures, and the fake. If the two disagree, the fake is wrong, and every test built on it is suspect.
- **Test the pure part with tables:** given this raw data, expect these findings and blockers. Include the id drift cases from phase 2: the same problem observed before and after each kind of change must produce the same id.
- **Make the fakes realistic,** as in this repository's [realistic world](https://github.com/chrisrocco/reconciler-loops/tree/main/src/fakes/realistic): writes that take time to show up, noisy readings, failures and timeouts, search indexes that lag, and people changing things mid-run. Idealized fakes pass tests that production fails.

**Gate:** every read has a typed client, fixture-backed tests and a fake that passes the same contract tests. The id drift cases pass. No read can turn a failure into an empty result.

## Phase 4: Write `plan`, then run it in shadow

**Write `plan` as repair, respond, then move forward on a clean frame,** as the guide describes. It is pure, so test it with tables: given this frame, expect these actions and keys. Add a test for each rule a person cares about, such as "never advance with an open bug". That test is the rule's enforcement.

**Write scenario tests** that run the whole loop in simulated time against the fakes: the past incidents from phase 1, the walk-throughs from phase 2, and crashes injected mid-tick. A run of weeks should take seconds.

**Then run the loop in shadow.** Deploy it against production with `act` replaced by a logger. It reads the real world, builds real frames and plans real actions, and changes nothing. This tests the riskiest part, reading the world correctly, with no risk at all.

- **Log each distinct action once,** keyed by its key. A shadow loop takes no actions, so nothing is ever claimed, and it proposes the same actions every tick.
- **Compare the plans with reality:** with what the existing workflow did, and with what people did. Every disagreement is a bug in the loop, a bug in the old system, or a design question. Write each one down and resolve it.
- **Check ids against real data.** For each real problem, count the distinct finding ids the loop produced over the shadow period. More than one means the id drifts.
- **If history is available, replay it.** Feeding past weeks of data through the pure parts finds cases that would take months to see live, such as a problem declared fixed that came back.

Run long enough to see every kind of finding at least once, and a full cycle of the work, such as a release cycle.

**Gate:** no unexplained disagreements, every kind of finding seen in real data, and one id per real problem.

## Phase 5: Turn on actions, one at a time

**Order actions by harm and reversibility.** Turn on the least harmful first, and production changes last:

1. labels and comments;
2. filing issues;
3. opening changes for review, such as draft PRs;
4. changes that reach production: merges, rollbacks, reverts, flag flips.

**Give each action its own flag.** The actions not yet turned on stay in shadow, logged but not taken.

**Never run two controllers on the same work.** If the existing workflow keeps running, split the work between them, for example by project, by team or by a tag, and give each side its share. Two systems acting on the same item will undo each other's work and file duplicates.

**Start small and widen.** Give the new loop a small share of the work first, and widen it as each action proves itself.

**Watch for trouble:**

- duplicates: search each system for two objects carrying the same finding's marker;
- the stalled warning, when a plan re-proposes an action already taken;
- escalations: read every one in the first weeks, because each is either a real problem or a design bug;
- actions a person had to undo.

**Gate, for each action:** it has run at its scope for an agreed period with no duplicates and no wrong actions, and every escalation was explained.

## Phase 6: Cut over

**Let the loop adopt work in flight.** Because it reads the world, the new loop can pick up work the old system started, if it can find it. Objects the old system created usually lack the new loop's markers, so backfill them: add the labels the loop searches for. Without that, the loop doesn't see the old system's open PR and writes a second fix.

**Turn the old system off,** and keep its history for reference.

**Write a short runbook:** how to pause the loop, how to hand a finding to a person by hand, how to read the tick log next to the workflow history, and who owns the loop.

**Gate:** the old system is off, nothing it knew is lost, and someone other than the implementer has used the runbook.

## Replacing a durable workflow

If the existing system is a workflow on a durable engine such as Temporal, much of it can be reused. The runtime stays, the integrations mostly stay, and the control flow is what changes.

| In the old workflow | In the loop |
| --- | --- |
| Variables that hold progress | Reads from the systems that own each fact, or attempt counts in the ledger |
| Activities that read | Reads in `observe`, with typed results that include "unknown" |
| Activities that write | Actions in `act`, each taking a key and safe to repeat |
| Sleeps and polls | The plan's `wake`: when to look again |
| Signals | Hints to look again sooner, or answers to questions. Never facts |
| Child workflows | Delegated loops, started with stable ids so a restart doesn't duplicate them |
| `if`s on stored state | Gone: `plan` decides from the frame |

- **Start a new workflow type** instead of patching the old one. Old runs finish or are stopped, and new work starts on the loop.
- **Don't port the control flow.** The old sequence of steps is a useful list of what can happen, not a design to copy.
- **Keep history bounded:** continue as new after a fixed number of ticks, and keep read results small.
- **Reuse the activity code,** adding keys to writes and "unknown" to reads.

## What to reject in review

- Progress stored in a workflow variable, such as `stage = 3`, instead of read from the world.
- An event or signal payload treated as a fact instead of a reason to look.
- A failed or truncated read treated as empty.
- An agent's output used directly as an action, or an agent building a key.
- A key without an attempt number on an action that might fail or be lost.
- An action without a marker the loop can find it by later.
- A finding id containing something that drifts: a version, a line number, a timestamp.
- "Done" checked against what the loop did instead of what it observes.
- A read returning raw data that the frame doesn't need.
- A fake that is more reliable than the system it stands in for.

## Design doc template

```
# <Loop name>: design

## Survey
- Stored state: <value | owner | readable there? | becomes>
- Systems: <name | reads | writes | write-to-read lag | markers | limits | failure modes>
- Other actors: <who changes these systems, and how>
- Past incidents: <one line each; each becomes a scenario test>

## Design
- Unit of work: <one item, a fleet, or both>
- Goal: <a check on what the loop observes, or "none: runs until cancelled">
- Findings: <kind | id scheme | what must not change the id | example ids>
- Responses: <finding kind | mitigate | delegate | needs approval?>
- Markers and deadlines: <action | marker | deadline>
- Blockers: <what in the world | which finding it covers>
- Agents: <call | typed answer or bounded work | how it is checked>
- Limits: <attempts | age | time budget | caps on work in flight>
- Escalation: <who | channel | contents>
- Safe hold: <what happens on stop or timeout>
- Remembered facts: <fact | why the world can't show it | what happens if lost>
- Library or hand-rolled: <choice>
- Walk-throughs: <ordinary path | person changes something | fix that doesn't work>
- Sign-off: <who, when>

## Rollout
- Shadow: <start date | disagreements found and resolved | ids per real problem>
- Actions: <action | flag | scope | turned on | issues seen>
- Cutover: <markers backfilled | old system off | runbook link>
```

## Using this as an agent skill

To give a coding agent this playbook in another project, save this page into that project as a skill, for example at `.claude/skills/reconciler-playbook/SKILL.md`, with a header like this one:

```
---
name: reconciler-playbook
description: Scope, sequence and build a reconciler loop in this project. Use when designing or implementing the loop, its connectors and reads, or its rollout.
---
```

Put the project's design doc next to it, and add any domain note that applies, such as [Applying the playbook: JavaScript error remediation](https://github.com/chrisrocco/reconciler-loops/blob/main/docs/playbook/js-error-remediation.md).
