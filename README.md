# Reconciler loops for durable agent workflows

One small primitive, `reconcile(rt, spec)`, drives very different loops: a local
multi-agent review (minutes), human code review (days), a live experiment ramp with
recursive bug investigations (weeks), a large-scale migration with a child loop per
component (months), and an on-call agent that never ends. It is a **level-triggered controller**, like a
Kubernetes controller, run on a durable-execution engine. The developer guide,
[docs/reconciler-loops.md](docs/reconciler-loops.md), explains the concepts from scratch;
this README is the map of the code. The site in `site/` teaches the pattern with an
interactive tutorial and runs every loop as a live simulation. Each loop has a plain-English
case study in [docs/case-studies/](docs/case-studies/): the job, what makes it hard, and what
the pattern gives it.

```
            ┌──────────────────────────────── tick ─────────────────────────────────┐
            │                                                                       │
 world ───▶ observe ──▶ frame ──▶ done? ──▶ out of ──▶ assess ──▶ plan ──▶ act ──────┤
 (systems    (activities) │        │yes     time?     (memoized  (pure)  escalations │
  of record)              │        ▼        │yes      judgments)         first, then │
                          │      done       ▼                            the plan;   │
                          │              out-of-time        halt? ◀───── one effect  │
                          │                                 escalated    per key     │
                          └── open / blocked / claimed / escalating ◀── ledger ◀─────┘
                                                                  acted? → tick now
                                                                  else   → wait(poll | hint)
```

## The eight rules

1. **Observe, don't remember.** Each frame is re-derived from systems of record (bug
   tracker, deploy system, metrics, CL threads). The loop never keeps "I filed bug B-1"
   as its own state; it sees B-1 in the tracker. That is why a fresh workflow with no
   memory can pick up any loop mid-flight, and why a human closing the bug by hand just
   works.
2. **Findings have stable fingerprints.** The same problem gets the same id on every
   tick (`regression:s2`, `correctness:auth.ts:42:null-deref`, `thread:t3@m7`). Put a
   version in the id when a new version deserves a new response: a reviewer's follow-up
   message is `@m7`, not `@m3`. Size a finding to its response: guardrails that fail
   together are one regression, because one debugging session answers them.
3. **Blockers are observed obligations.** A child bug that is still open, a CL not yet
   in prod, a draft waiting on the owner. A blocker names the findings it is handling
   (`on`) and its scope: `loop` holds all forward progress; `finding` gates only those
   findings. **The recursive child bug is just a blocker**: the parent sees it in the
   next frame because the bug tracker says it's open, and stays held until the tracker
   says it's closed.
4. **Every frame partitions findings into `open | blocked | claimed`.** Only `open`
   findings get acted on. `claimed` covers the gap between "I submitted the fix" and
   "the deploy system shows it": an action with a `deadlineMs` holds its findings until
   the matching blocker shows up and then clears, or until the deadline passes (the effect
   is presumed lost, so the finding opens again). This is Kubernetes' *expectations* trick
   for observation lag.
5. **Actions are intents with deterministic keys.** The ledger never runs the same key
   twice in a loop's lifetime, and destinations dedupe on the key too (bug label, CL
   change-id, comment key). Put a generation in the key when a repeat is intended:
   `fix:regression:s2:2` for the second attempt, `advance:1->2@<stageEnteredAt>` to re-advance
   after a rollback. Any action whose effect can be lost (past its deadline) or can fail to
   resolve its finding needs that attempt number; otherwise the plan re-proposes a key the
   ledger has already spent. `reconcile` escalates such a finding at once and reports it
   (`stalled` in the tick record) instead of polling silently.
6. **Escalate per finding; never end the loop for one.** A finding out of attempts
   (counted since its last escalation), too old (`maxFindingAgeMs`), or repeating itself
   is handed to a person with `escalate:<finding>:<attempt>`. The escalation shows up in
   the world as a blocker, so that finding waits for the person while the loop carries on.
   When the person is done, a finding that is still there gets fresh attempts. A loop ends
   only when its goal is met, it runs out of time, or its plan says stop.
7. **Progress only on a clean frame.** The playbook responds to findings, and forward
   motion (advance a stage, submit the CL) happens only when nothing is open, blocked,
   or claimed. "Never advance while held" is then an invariant, and the tests check it.
8. **Signals are hints; polling is truth.** A child closing its bug sends
   `hint(parent, 'child-closed')` so the parent wakes early, but correctness never
   depends on the hint arriving. Removing every hint only makes the loops slower.

## The spec: up to five functions

```ts
interface ReconcilerSpec<World, F extends Finding, A extends Action, Judgment> {
  observe(ctx): Promise<{ world; findings; blockers }>; // activities: read systems of record
  assess?(open, ctx): Promise<Record<id, Judgment>>;    // activities, memoized: classify / triage
  done?(frame): string | undefined;                      // pure; left out by a loop that never ends
  plan(frame): { actions; wake; halt? };                 // pure: decision table over the frame
  act(action | EscalateAction, frame, facts): Promise<void>; // one effect, escalations included
  budget?: { maxDurationMs?, maxAttemptsPerFinding?, maxFindingAgeMs?, retentionMs?, escalationDeadlineMs? };
}
```

`reconcile()` returns an `Outcome`: `done`, `out-of-time`, `escalated | failed` (the plan
said stop), or `checkpoint`. The calling workflow decides what to do with it, such as the
experiment's safe hold. That is what makes the loop callable at any point inside a workflow
(the review loop runs inline mid-authoring), and what lets a loop *be* a whole workflow (the
experiment).

The **only** state the loop owns is `LoopMemory` (version 2; version 1 is migrated when
read), which is JSON-serializable and small: the ledger (for dedupe and per-finding
attempts), memoized judgments with their timestamps, counts of forgotten ledger entries,
and a few named `facts` the world can't show (the experiment id). On `checkpoint`, the
caller does `continueAsNew({ ...input, memory })`. With `retentionMs` set, settled ledger
entries and judgments older than that are forgotten, but attempt numbers keep counting up,
so a loop with no goal and no time budget runs indefinitely in bounded memory.

After a tick that acted, the loop looks again immediately, but at most `maxImmediateTicks`
(default 10) times in a row; after that it honors the plan's `wake`. A plan that keeps
issuing fresh keys against a world that never changes, such as a tick-keyed repair while
a status read lags, then polls instead of spinning with no time passing.

Questions for people (use this experiment or create one? approve these fields?) go through
`Decisions` (`src/core/decisions.ts`). `observe` reads the answers, so `plan` stays pure,
and an unanswered question is a blocker that holds the loop. In Temporal the answers arrive
by signal (`reconciler.answer`); each kind of question can be set to auto-approve the
agent's suggestion.

## Durability, three layers deep

| Failure | What saves you |
|---|---|
| Worker crash / redeploy mid-tick | The engine's replay (activities recorded in history) |
| History grows over weeks | `maxTicksPerRun` or Temporal's `continueAsNewSuggested` → `checkpoint` → continue-as-new carrying `LoopMemory` |
| Workflow terminated, reset, incompatible code change, or loop started late | Level-triggered observation: a new run with **no** memory re-derives everything; idempotent keys prevent duplicate effects; a *repair* step in `plan` restarts orphaned child investigations |

## The scenarios

| | Local review | Code review | Live experiment |
|---|---|---|---|
| Input | a change | a CL | a flag name: mounts the experiment on it, or creates one |
| Findings | reviewer comments, per dimension | every unmet submit requirement: threads awaiting us, approvals nobody assigned can grant, failing or running checks, a conflict | `unmounted`, one regression for all the guardrails failing together |
| Assess (memoized) | (none; reviews memoized per revision) | judge each thread once per message, then the response policy | debugging-playbook triage per episode |
| Blockers | none | drafts and questions with the owner, a present reviewer who can grant an approval, running checks (`finding` scope) | open child bugs, undeployed fix CLs, open pages, unanswered questions (`loop` scope) |
| Actions | `revise` (all open findings, batched) | `revise` (batched), `reply` (post/draft), `add-reviewer`, `rerun`, `rebase`, `submit` | `mount`, `create`, `rollback`, `submit-fix`, `file-bug`, `start-investigation`, `advance`, `conclude` |
| Escalation | stops the inline loop; the caller hands the change over | tags the CL owner (attention set + @-mention) | pages on-call and rolls back to stage 0 |
| Done | no blocking findings | CL submitted | ramped to 100% |
| Ends early | escalated, or out of rounds (the plan stops) | 30 days | 60 days → safe hold |

**The recursive investigation** (`src/scenarios/investigation.ts`) is the same primitive
again: its findings are what it still lacks (root cause, prerequisite, fix), and its blockers
are *its own* sub-bugs and fix CLs. Deployed is not cured: once its fix is live it calls
`verifyFix`, closes the bug only on `cured`, and treats `reproduces` as a finding that sends
it back to RCA (a fix only counts if its `ref` matches the current root cause). After three
ineffective fixes it escalates: `escalateBug` hands the bug to a person, and the person's
blocker holds the investigation, and through the open bug the parent, until they close the
bug or hand it back.
It can spawn grandchildren up to `maxDepth`. Each level
sees only its direct children, and the parent stays blocked because the child's bug stays
open until the whole subtree resolves. Children are started with
`parentClosePolicy: ABANDON` and a deterministic workflow id (`investigate:<bugId>`), so
they outlive a terminated parent and can't be double-started.

**Escalation holds, it doesn't halt.** When triage says a regression needs a human, or a regression
runs out of attempts or goes unresolved for 7 days, the experiment loop escalates it: a page
to on-call keyed `escalate:<regression>:<attempt>`, plus a rollback (to stage 0 for the loop's
own escalations) that names no targets, so it doesn't use up an attempt. The open page holds
the loop like any other loop-scoped blocker. Once on-call resolves it, the loop carries on:
if the regression is gone the ramp resumes, and if it's still there the agent gets fresh
attempts. Only the 60-day budget ends the ramp, with a safe hold.

**Code review** (`src/scenarios/code-review.ts`). The agent drives a change to submitted,
posting as itself for the owner. Every unmet submit requirement is a finding and anything
in progress that will meet it is a blocker, so the only forward step is submit. Requirements
(review, owners per directory, language) are read from the review system, so porting is a
matter of mapping fields. A reviewer who can grant an approval covers it while present, and
ages it only while it's their turn; nobody able to grant it means the loop adds someone.

**Experiment by flag.** The input is `{ flagName }`. Everything the loop files is labeled
`exp:<flag>`, and the workflow id is `experiment:<flag>`. Until it manages an experiment, the
loop has an `unmounted` finding: it asks whether to use an experiment already on the flag
(suggesting it when there's exactly one) or create one from an agent-drafted config that a
person approves. The experiment id is kept as a named fact in loop memory, because the experiment service
has no label to find it by. A run that lost it asks again, and create returns the existing
experiment when the launch bug matches, so a retry never makes a second one.

**A regression is one finding.** Guardrails that fail together usually fail for one cause, so
the experiment groups them into one finding per treatment (per arm), with the failing
metrics as its data: one triage, one bug, one attempt count and age. Distinct causes are
split by the investigation, as sub-bugs. The id is the highest stage reached
(`regression:s2`), so it stays the same while metrics join or recover, through rollbacks
and fixes that don't work, and when the same problem returns after a re-advance; a new
stage starts a new finding. Defects can move correlated guardrails (`alsoMoves`), and the
`correlated` scenario has an error rate joining mid-investigation without a second bug.

**Experiment variants.** `RAMP_POLICIES` has fast, standard, cautious and holdback ramps.
The holdback ramp launches to 99% and keeps a 1% holdback for four weeks; with a defect
whose harm only shows after ten days (`onsetMs`), it catches what a short soak would miss.
A **multi-arm** experiment ramps each treatment arm on its own: regressions are per arm
(`regression:<arm>:s<stage>`), an arm's bugs, fixes and pages hold only that arm
(finding-scoped blockers), and each arm advances on its own clean slice of the frame. In the
realistic world each arm has its own traffic share, analysis window and noisy readout.

**Migration** (`src/scenarios/migration.ts`). A campaign loop finds `legacy:<path>` per
component still on the old framework and starts a child loop per component, within
work-in-progress limits (overall, per owner, smallest first). A component's old-framework
dependencies are **prerequisite** blockers, which never count toward its age. Each child
converts, verifies every patchset, fixes failing checks, converts again when the code
changes underneath, goes through review and submits, or escalates to the owning team. The
campaign shrinks the allowlist as components move and runs the cleanup on a clean frame.

**On-call** (`src/scenarios/on-call.ts`). No goal and no time budget. Broken builds (keyed
by the first bad CL), flaky tests, canary alerts, quarantined tests, paused releases and
reverted CLs are findings. Each is mitigated locally (revert, quarantine, pause) and
delegated durably (one issue for its owner, which also covers the follow-on finding). If a
revert doesn't turn the build green, the loop reverts the next suspect while the issue
stays open. Ignored issues age out after 3 days and go to the lead; retention keeps memory
bounded.

## Timeline: experiment with a two-level investigation

`npx tsx examples/experiment-timeline.ts` (virtual time; two weeks run in well under a second):

```
d0+00:00 [experiment:checkout_v2]  findings=unmounted → mount:E1:1     (the one experiment on the flag)
d3+00:00 [experiment:checkout_v2]  → advance:1->2@…                     (ramp to 25%)
d3+06:00 [experiment:checkout_v2]  findings=regression:s2
                                   → rollback:…:1 | bug:…:1             (safety first, then the playbook)
d3+06:00 [experiment:checkout_v2]  blockers=bug:B-1 → start:B-1         (next frame SEES the bug; repairs: no investigator yet)
d4+02:00     [investigate:B-1] findings=sub:stale FX rates → files B-2, starts investigate:B-2
d4+20:00         [investigate:B-2] → close                              (fix live and verified; hints B-1)
d4+20:00     [investigate:B-1] woke=signal:child-closed → fix:1
d5+04:00     [investigate:B-1] → close                                  (hints experiment)
d5+04:00 [experiment:checkout_v2]  woke=signal:child-closed             (held → clean; waits for a fresh metrics window)
d5+10:00 [experiment:checkout_v2]  → advance:1->2@…                     (re-advance, new key)
d13+10:00 [experiment:checkout_v2] → conclude
```

## Tests: `npm test` (59 tests, all virtual time)

Experiment: happy path · quick fix held on deploy · child investigation blocks the parent ·
recursion to depth 2 · **crash right after filing the bug, then a no-memory restart (no
duplicate bug, investigation repaired, experiment found again on the flag)** · a human
closes the bug out-of-band · a fix that never works is escalated after 3 attempts, rolls
back to stage 0, gets fresh attempts after each page, and safe-holds at 60 days · playbook
escalation rolls back, pages, holds until on-call resolves it, then finishes · a live fix
for the wrong root cause doesn't close the bug, re-analysis finds the real one · fixes that
never cure hand the bug to a person, holding the parent · depth limit → child escalates,
parent stays blocked until a human acts · continue-as-new across 10+ checkpoints · by flag:
creates the experiment from the approved draft · a question holds the loop until a person
answers, then mounts their choice · a run that lost its memory after creating finds the
experiment instead of creating another · ramp policies each ramp through their own stages ·
a long-term holdback catches late harm before it ends · multi-arm: one arm rolls back and
waits on its bug while the others keep ramping · three correlated metrics (one joining
mid-investigation) give one triage, one bug and one finding · a regression at a new stage
gets a new finding with fresh attempts.
Migration: every component moves and the old framework is removed · work-in-progress limits
and prerequisites hold at every moment, and only the hard component is escalated.
On-call: 90 days with no goal or budget, every breakage green within two hours, ignored
issues escalated, memory bounded · reproducible from the seed.
Code review: the pure findings and blockers · a typical review (owners added past an absent
reviewer, comments fixed in one patchset, answered, drafted, put to the owner, a flaky check
rerun, a rebase, submitted with every requirement met) · started late · lost drafts retried,
then escalated · an unresponsive reviewer aged out and swapped · votes that reset after a
conflict · a check that won't pass, escalated and fixed by the owner.
Review loop: converges through a regression introduced by a fix · advisory-only findings
don't block · a stubborn finding is escalated and stops the inline loop · round limit.
Core: a lost action re-proposed under a spent key is escalated at once · a plan that acts
every tick polls instead of spinning · escalation when out of attempts, in flight, and after a
person's answer (fresh attempts) · aging, and prerequisites that don't age · retention
keeps attempt numbers counting · v1 memory migration · an on-call loop with no goal and no
time budget runs a simulated year in bounded memory.
Realistic world: every scenario over 20 seeds keeps every invariant (see below).

## Site: `site/` (Vite + React)

```
npm --prefix site install
npm run site            # http://localhost:5174
npm run site:build      # static build in site/dist, servable from any path
```

- **Learn**: a tutorial covering every concept in the guide, each lesson with a short quiz
  (progress is kept in the browser). Interactive widgets run the real core: the
  sort-a-finding and escalation widgets call `buildFrame` and `escalation`, and the
  plan widget calls the experiment's own `plan`.
- **Simulate**: every loop runs on the virtual-time simulator in the browser, using the real
  `src/` code, then plays back tick by tick: the experiment ramp (every catalog scenario,
  any ramp policy and seed, multi-arm, all in the realistic world), code review, the inline review
  loop, the migration campaign, and the on-call agent. Each shows the loops as lanes of
  ticks, the world at the playhead, the frame the selected tick saw, and an event log.

## Realistic world: `src/fakes/realistic/`

`ProdWorld` is deliberately ideal: exact metrics, instant consistency, an 8h deploy,
agents that are always right. It is the fixture for the exact unit tests and nothing else;
the site runs only the realistic world. `RealisticWorld` runs the same scenarios against systems
modeled on how a large engineering org runs experiments and ships fixes. Every run is
reproducible from a seed. The framework code is unchanged; everything realistic lives
behind the activity interfaces, the way a production adapter would.

| System | What it does to the loops |
|---|---|
| Experiment analysis (`metrics.ts`) | Five guardrails as relative changes with CIs. Noise shrinks with traffic × hours, so 1% arms are often inconclusive. Data lands ~2h late, the pipeline stalls for hours every few weeks, and false positives occur at the rate the statistics imply. |
| Issue tracker (`bug-tracker.ts`) | Statuses like a mature tracker (DUPLICATE, INTENDED_BEHAVIOR, …). Search lags writes by ~40s, RPCs fail transiently, and create has no idempotency token and sometimes times out after committing. |
| Review + release (`release.ts`) | Presubmit with flaky reruns, code-owner review in working hours, submit queue, a daily weekday release cut, qualification, then canary 1% → 10% → 50% → 100%, paused on weekends. Releases sometimes roll back. A fix takes 1–4 days, not 8h. |
| Agents (`world.ts`) | Triage picks the right route ~80% of the time and still proposes something on noise. RCA takes hours, and is sometimes inconclusive, wrong, or misses a prerequisite. |
| Verification (`world.ts`) | A live fix is verified by a repro at the defect's trigger load after a 6h soak; the verdict is wrong 5% of the time. |
| People (`world.ts`) | A triager marks duplicates. On-call answers pages within hours at any time, and picks up escalated investigations in working hours; either way they ship the real fix, or call it noise, and give up after a week on a fix that won't take. |
| Engine (`sim.ts`) | Activities retry with backoff like Temporal (`DEFAULT_RETRY`); `describe()` lags a fresh start by a second or two. |

The rates and durations are estimates from public descriptions of such systems, not
measured data. They live as constants at the top of each file, so recalibrate them
against your own numbers when you have them.

`npm test` sweeps every scenario over 20 seeds and checks the guarantees that must hold
whatever the world does: never advance while held (both as the loop saw it and by ground
truth), a finished ramp leaves no open obligations, every investigation terminates, and
runs are reproducible. `npx tsx examples/realistic-report.ts 50` prints outcome
distributions, how often each imperfection occurred, and outcome quality against ground
truth.

## Layout

```
src/core/        types.ts · reconcile.ts (the loop, ledger, escalation, retention, memo, migration)
                 runtime.ts (engine port) · decisions.ts (questions for people) · time.ts
src/runtime/     sim.ts (virtual-time engine: children, hints, terminate) · temporal.ts (adapter, answer signal, logTick)
src/scenarios/   review-loop.ts · code-review.ts · experiment.ts · investigation.ts · systems.ts
                 migration.ts (campaign + component) · on-call.ts
src/fakes/       prod-world.ts (idealized, for unit tests; ramp policies) · review-world.ts · review-system.ts (code review) · catalog.ts
                 migration-world.ts (codebase, SAMPLE_APP) · on-call-world.ts (seeded org)
                 realistic/ world.ts · metrics.ts · bug-tracker.ts · release.ts · calendar.ts · rng.ts · harness.ts
examples/        experiment-timeline.ts · realistic-report.ts · temporal-workflows.ts (real proxyActivities/continueAsNew wiring)
docs/            reconciler-loops.md (the developer guide)
site/            Vite + React site: content/ (lessons, quizzes) · widgets/ · sims/ (one per loop) · components/ (players)
```

The runtime port is four methods (`now`, `wait`, `startChild`, `hint`), plus an optional
`historyLarge` check. If your engine is "Temporal-style" rather than Temporal itself,
`src/runtime/temporal.ts` is the template.

## Known edges / next steps

- **Snapshot skew.** `observe` reads several systems at slightly different times.
  Level-triggering tolerates this (the next tick corrects it), but a destructive action
  should re-check its precondition inside its activity.
- **Fast blockers.** A blocker that appears *and* clears between two polls is never seen,
  so its action stays claimed until its deadline. That is safe but slow; set `deadlineMs`
  close to the expected effect latency, or have the activity return the blocker id.
- **Attempts live in memory.** A no-memory restart resets per-finding attempt counts. If
  that matters, derive attempts from the world (count bugs/CLs labeled with the finding).
- **Fresh attempts can repeat forever on a defect nobody can fix.** Each time on-call
  hands an escalation back, the agent tries three more times. In the 50-seed thrash
  scenario that is about 7 pages per run over 60 days. Loops that touch production may
  want to escalate a recurrence straight back to a person instead.
- **Questions have no deadline.** An unanswered question holds the loop, and it doesn't
  age (it has no `since`), so only the time budget ends the wait. The same goes for a page
  nobody resolves; an SLA (re-ask or re-page, then safe hold) would bound both.
- **Answers live in workflow state.** They are carried across continue-as-new, but a
  terminated run loses any answer not yet acted on, and the question is asked again.
- **Long agent activities** (RCA) can't see the world change mid-run; use heartbeats plus
  cancellation if the bug closing should abort them.
- **Verification is only as good as its signal.** Investigations close on a verified cure,
  not on deploy, but a wrong `cured` verdict (5% in the realistic world) still closes a bug
  early; the parent then sees the regression again, as its next attempt. Of the 117 bugs closed
  before their cure in the 50-seed report, 3 were closed by agents on a wrong verdict; the rest are
  scenario scripts in which a human closes the bug on a fixed clock.
- **Payload size.** Memory rides in every continue-as-new, and Temporal limits payload
  size (2 MB by default, as far as we know; check your deployment). Retention bounds a
  single loop; very wide loops should split into child loops (guide section 8).
