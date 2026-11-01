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

## The code

The loop is one spec, `experimentSpec`, in `src/scenarios/experiment.ts`. These are the parts to read first.

A regression is one finding for every guardrail failing together. Its id is the highest stage the ramp has reached, so a rollback or a fix that didn't work keeps the same finding and its attempt count:

<!-- source: src/scenarios/experiment.ts#experiment-regressions -->
```ts
/**
 * Group failing guardrails into one regression per treatment (per arm). The id is the highest
 * stage reached: stable while the set of failing metrics changes, through rollbacks, fixes that
 * don't work, and the same problem recurring after a re-advance; new once the ramp reaches a
 * stage it never had. (The time of the last advance would treat each recurrence as new, with
 * fresh attempts and a fresh age, so a problem nobody can fix would never age out.)
 */
function regressions(exp: ExperimentState, readings: GuardrailReading[]): Regression[] {
  const groups = exp.arms ? exp.arms.map((a) => ({ arm: a.name as string | undefined, peakStage: a.peakStage })) : [{ arm: undefined, peakStage: exp.peakStage }];
  return groups.flatMap(({ arm, peakStage }) => {
    const failing = readings.filter((r) => r.arm === arm && r.verdict === 'fail');
    if (!failing.length) return [];
    return [{
      id: `regression:${arm ? `${arm}:` : ''}s${peakStage}`, kind: 'regression' as const, severity: 'blocking' as const,
      summary: `${arm ? `${arm}: ` : ''}${failing.map((r) => r.guardrail).join(', ')} failing`,
      data: { failing, severity: failing.some((r) => r.severity === 'severe') ? 'severe' as const : 'mild' as const, arm, peakStage },
    }];
  });
}
```

Everything the loop files is found again by its label, and each open obligation becomes a blocker. In a multi-arm experiment, an arm's obligations hold only that arm:

<!-- source: src/scenarios/experiment.ts#experiment-blockers -->
```ts
// An arm's obligations hold only that arm (finding scope; plan checks each arm); everything else holds the loop.
const scope = (finding: string) => (armOf(finding) ? 'finding' as const : 'loop' as const);
const blockers: Blocker[] = [
  ...openBugs.map((b) => ({ id: `bug:${b.id}`, kind: 'child-bug', on: [b.finding], scope: scope(b.finding), summary: b.title, since: b.createdAt })),
  ...fixes.filter((x) => x.state !== 'in-prod').map((x) => ({ id: `deploy:${x.clId}`, kind: 'deploy', on: [x.finding], scope: scope(x.finding), summary: `${x.clId} rolling out` })),
  ...pages.filter((p) => p.status === 'open').map((p) => ({ id: `page:${p.id}`, kind: 'page', on: [p.finding], scope: scope(p.finding), summary: p.reason, since: p.openedAt })),
];
```

The agent's triage runs in `assess`. Its answer is stored once per attempt, so a workflow that restarts doesn't pay for it again, and a fix that didn't work gets a fresh look:

<!-- source: src/scenarios/experiment.ts#experiment-assess -->
```ts
async assess(open, { memo, attempts, facts }) {
  const out: Record<string, Triage> = {};
  for (const f of open) {
    if (f.kind !== 'regression') continue;
    const ep = (attempts[f.id] ?? 0) + 1;
    out[f.id] = await memo.get(`triage:${f.id}:${ep}`, () => acts.triage(facts[EXPERIMENT_ID] as string, f.data.failing, ep));
  }
  return out;
},
```

`plan` is pure: it reads the frame and returns actions. Read it top to bottom. It repairs first (restarting an investigation nobody is running, mounting the experiment), then mitigates escalations, then responds to each open regression along the route triage chose, and advances a stage only on a clean frame:

<!-- source: src/scenarios/experiment.ts#experiment-plan -->
```ts
plan(f) {
  const { exp, bugs, investigations } = f.world;
  const actions: ExpAction[] = [];

  // 1. Repair — level-triggered self-healing: open child bug, nobody investigating.
  for (const b of bugs.filter((b) => b.status === 'open'))
    if (investigations[b.id] === 'unknown' || investigations[b.id] === 'terminated')
      actions.push({ key: `start:${b.id}@${f.tick}`, kind: 'start-investigation', bugId: b.id });

  // Mounting or creating the experiment is repair too: once people have answered.
  if (!exp) {
    const unmounted = f.open.find((x) => x.kind === 'unmounted');
    if (unmounted) {
      const n = (f.attempts[unmounted.id] ?? 0) + 1;
      const { mountChoice, approvedConfig } = f.world;
      if (mountChoice && mountChoice !== CREATE) actions.push({ key: `mount:${mountChoice}:${n}`, kind: 'mount', targets: [unmounted.id], experimentId: mountChoice });
      else if (approvedConfig) actions.push({ key: `create:${flag}:${n}`, kind: 'create', targets: [unmounted.id], config: approvedConfig });
    }
    return { actions, wake: { afterMs: HOUR, signals: ['answered', 'child-closed'] }, note: f.held ? `unmounted; held by ${f.blockers.map((b) => b.id).join(',')}` : 'unmounted' };
  }

  // 2. Mitigate locally while a person takes over: the loop files the escalation (a page);
  // the rollback names no targets, so it doesn't use up one of the breach's attempts.
  for (const e of f.escalating) {
    const arm = armOf(e.finding.id);
    if (stageOf(exp, arm) > 0) actions.push({ key: `safe-hold:${e.finding.id}:${(f.attempts[e.finding.id] ?? 0) + 1}`, kind: 'rollback', to: 0, arm });
  }

  // 3. Respond — debugging playbook for each breach nobody is handling.
  for (const x of f.open) {
    if (x.kind !== 'regression') continue;
    const ep = (f.attempts[x.id] ?? 0) + 1;
    const t = f.assessments[x.id]!;
    const arm = x.data.arm;
    if (x.data.severity === 'severe' && stageOf(exp, arm) > 0) actions.push({ key: `rollback:${x.id}:${ep}`, kind: 'rollback', to: stageOf(exp, arm) - 1, arm });
    // Hold, don't halt: the page is a loop-scoped blocker until on-call resolves it. If the
    // breach is still there afterwards, it is triaged again as the next attempt.
    if (t.route === 'escalate') actions.push(escalation({ finding: x, reason: t.reason }, f, budget));
    if (t.route === 'quick-fix')
      actions.push({ key: `fix:${x.id}:${ep}`, kind: 'submit-fix', targets: [x.id], patch: t.patch, deadlineMs: HOUR });
    if (t.route === 'investigate')
      actions.push({ key: `bug:${x.id}:${ep}`, kind: 'file-bug', targets: [x.id], title: t.title, signature: t.signature ?? x.id, deadlineMs: HOUR });
  }

  // 4. Progress — only on a clean frame. With several arms, each arm on its own clean slice.
  if (exp.arms) return progressArms(f, exp, exp.arms, actions);
  if (!f.findings.length && !f.blockers.length && exp.status === 'running') {
    const soakLeft = exp.stageEnteredAt + exp.stages[exp.stage]!.soakMs - f.now;
    if (f.world.readings.every((r) => r.verdict === 'pass') && soakLeft <= 0) {
      actions.push(exp.stage < exp.stages.length - 1
        ? { key: `advance:${exp.stage}->${exp.stage + 1}@${exp.stageEnteredAt}`, kind: 'advance', to: exp.stage + 1 }
        : { key: 'conclude', kind: 'conclude' });
    }
    return { actions, wake: { afterMs: clamp(soakLeft, 15 * MIN, 6 * HOUR) }, note: `stage ${exp.stage}, soak left ${Math.max(0, soakLeft)}` };
  }
  return { actions, wake: wakeWhileHeld(f), note: f.held ? `held by ${f.blockers.map((b) => b.id).join(',')}` : undefined };
},
```

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
