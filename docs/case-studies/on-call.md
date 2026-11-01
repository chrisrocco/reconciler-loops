# On-call agent

An agent keeps builds green and releases moving, forever. It reverts bad changes, quarantines flaky tests and pauses risky releases at once. Then it files one issue per problem for the owner.

## The job

Every team that ships software has someone on call. When a bad change breaks the build, they revert it. When a test starts failing at random, they quarantine it so it stops blocking everyone. When a daily release trips an alert in canary, they pause it. For each problem they file an issue for the owner and follow up until it's fixed. The work never finishes. There is always another broken build next week.

## What makes it hard

- **There's no finish line.** The loop has no goal and no time budget, so anything it remembers grows forever unless it forgets on purpose.
- **Mitigate fast, fix slowly.** A revert takes minutes. The real fix belongs to the owner and takes days, and it has to be tracked the whole time.
- **The first guess can be wrong.** The change suspected of breaking the build may be innocent. The agent has to try the next suspect.
- **Mitigations have costs.** A quarantined test is lost coverage. A reverted change is work someone has to reland. Neither should be forgotten.
- **Owners ignore issues.** Someone has to notice and go to their lead.
- **Old names come back.** The same build target breaking next week is a new problem, not a continuation of last week's.

## How the loop sees the work

**Goal:** none. The loop runs until someone cancels it.

**What it reads, every tick:** the build status of each target, the test results, the releases and their canary alerts, and the open issues.

**Findings:**

| Finding | What it means |
| --- | --- |
| `build:<target>@<first bad change>` | A target broken since that change |
| `flaky:<test>` | A test failing at random and not yet quarantined |
| `quarantined:<test>` | Coverage lost until the owner fixes the test |
| `canary:<release>:<alert>` | An alert firing on a release in canary |
| `paused:<release>` | A release held back until its fix lands |
| `reverted:<change>` | A reverted change, until its owner relands it |

**Blockers:** an open issue, labeled with its finding, covers that finding and the finding that follows from it.

**What it does:** mitigate locally and delegate durably. It reverts the culprit, quarantines the test or pauses the release, and files one issue for the owner. When an issue for a paused release closes, it resumes the release.

## What the architecture gives you here

- **Mitigate locally, delegate durably.** The agent acts within its own authority right away, and hands the lasting fix to the owner as an issue. Mitigation continues while the issue is open: if a revert doesn't turn the build green, the next suspect is reverted.
- **The cost of a mitigation stays visible.** Quarantining a test leaves a `quarantined:` finding until the test is fixed. Reverting a change leaves a `reverted:` finding until it's relanded. Lost coverage and unlanded work stay on the books.
- **Escalation is per problem.** An issue ignored for three days goes to the team lead. The loop never stops because one problem is stuck.
- **Memory stays bounded.** Settled entries are forgotten after a 14-day retention period. The loop runs for a quarter, or indefinitely, without its memory growing.
- **A new breakage is a new problem.** The first bad change is part of the build finding's id. Next week's breakage of the same target gets fresh attempts.

With no finish line, attempts, age and time budgets stop measuring progress. What matters is whether problems close faster than they open. A dashboard should show that rate, rather than the loop deciding it.

## The code

From `src/scenarios/on-call.ts`. Each finding's id carries what makes it a new problem: the first bad change for a broken build, the release for a canary alert. An open issue labeled with a finding covers it:

<!-- source: src/scenarios/on-call.ts#oncall-observe -->
```ts
async observe() {
  const [broken, flaky, releases, reverts, issues] = await Promise.all([
    acts.brokenTargets(), acts.flakyTests(), acts.releases(), acts.reverts(), acts.listIssues(self),
  ]);
  const findings: OnCallFinding[] = [
    ...broken.map((b) => ({ id: `build:${b.target}@${b.firstBadCl}`, kind: 'build' as const, severity: 'blocking' as const, summary: `${b.target} red since ${b.firstBadCl}`, data: b })),
    ...flaky.map((t) => t.quarantined
      ? { id: `quarantined:${t.test}`, kind: 'quarantined' as const, severity: 'blocking' as const, summary: `${t.test} quarantined`, data: t }
      : { id: `flaky:${t.test}`, kind: 'flaky' as const, severity: 'blocking' as const, summary: `${t.test} flakes ${Math.round(t.flakeRate * 100)}%`, data: t }),
    ...releases.filter((r) => r.state === 'canary').flatMap((r) => r.alerts.map((a) => ({ id: `canary:${r.id}:${a.alert}`, kind: 'canary' as const, severity: 'blocking' as const, summary: `${a.alert} firing on ${r.id}`, data: { release: r.id, ...a } }))),
    ...releases.filter((r) => r.state === 'paused').map((r) => ({ id: `paused:${r.id}`, kind: 'paused' as const, severity: 'blocking' as const, summary: `${r.id} paused`, data: r })),
    ...reverts.filter((r) => r.landedAt !== undefined && r.relandedAt === undefined).map((r) => ({ id: `reverted:${r.cl}`, kind: 'reverted' as const, severity: 'blocking' as const, summary: `${r.cl} reverted, not relanded`, data: r })),
  ];
  const blockers: Blocker[] = issues.filter((i) => i.status === 'open').map((i) => ({
    id: `issue:${i.id}`, kind: i.escalated ? 'lead' : 'issue', on: [i.finding, ...followOn(i.finding)], scope: 'finding', summary: `${i.owner}: ${i.finding}`, since: i.createdAt,
  }));
  return { world: { broken, flaky, releases, reverts, issues }, findings, blockers };
},
```

An issue also covers the finding its fix will clear. The issue for a broken build covers the revert that follows it, so the loop doesn't file a second issue to reland the change:

<!-- source: src/scenarios/on-call.ts#oncall-follow-on -->
```ts
/** The finding an issue's fix also clears: a quarantined test, a paused release, a reverted first bad CL. */
export const followOn = (finding: string) =>
  finding.startsWith('build:') ? [`reverted:${finding.split('@')[1]}`]
    : finding.startsWith('flaky:') ? [finding.replace(/^flaky:/, 'quarantined:')]
    : finding.startsWith('canary:') ? [`paused:${finding.split(':')[1]}`] : [];
```

`plan` mitigates locally with no targets, so a revert isn't counted as an attempt, and delegates durably with one issue per finding. While the owner works, it keeps reverting suspects until the build is green:

<!-- source: src/scenarios/on-call.ts#oncall-plan -->
```ts
plan(f) {
  const actions: OnCallAction[] = [];
  const n = (id: string) => (f.attempts[id] ?? 0) + 1;
  const issue = (x: OnCallFinding, finding: string, owner: string, title: string): OnCallAction =>
    ({ key: `issue:${x.id}:${n(x.id)}`, kind: 'file-issue', targets: [x.id], finding, owner, title, deadlineMs: HOUR });

  // Respond: mitigate locally (no targets, so it isn't an attempt), delegate durably (one issue).
  for (const x of f.open) {
    if (x.kind === 'build') {
      actions.push({ key: `revert:${x.data.suspects[0]}`, kind: 'revert', cl: x.data.suspects[0]! });
      actions.push(issue(x, x.id, x.data.owner, `${x.data.target} broken by ${x.data.firstBadCl}`));
    }
    if (x.kind === 'flaky') {
      actions.push({ key: `quarantine:${x.data.test}:${n(x.id)}`, kind: 'quarantine', test: x.data.test });
      actions.push(issue(x, x.id, x.data.owner, `${x.data.test} is flaky`));
    }
    if (x.kind === 'quarantined') actions.push(issue(x, `flaky:${x.data.test}`, x.data.owner, `${x.data.test} is quarantined`));
    if (x.kind === 'reverted') actions.push(issue(x, x.id, x.data.owner, `reland ${x.data.cl}`));
    if (x.kind === 'canary') {
      actions.push({ key: `pause:${x.data.release}:${n(x.id)}`, kind: 'pause', release: x.data.release });
      actions.push(issue(x, x.id, x.data.owner, `${x.data.alert} on ${x.data.release}`));
    }
    // Repair: its issue is closed, so the fix has landed. Resume; if the alert comes back, it's a new attempt.
    if (x.kind === 'paused') actions.push({ key: `resume:${x.data.id}:${n(x.id)}`, kind: 'resume', targets: [x.id], release: x.data.id });
  }

  // Keep mitigating while the owner works: a revert that landed without turning the build green
  // means the first suspect was innocent. Revert the next one (its CL is in the key).
  for (const x of f.blocked) {
    if (x.kind !== 'build') continue;
    const reverted = x.data.suspects.filter((cl) => f.world.reverts.some((r) => r.cl === cl));
    const settled = reverted.every((cl) => f.world.reverts.some((r) => r.cl === cl && r.landedAt !== undefined && f.now - r.landedAt > 30 * MIN));
    const next = x.data.suspects.find((cl) => !reverted.includes(cl));
    if (reverted.length && settled && next) actions.push({ key: `revert:${next}`, kind: 'revert', cl: next });
  }

  const counts = ['build', 'flaky', 'quarantined', 'canary', 'paused', 'reverted'].map((k) => `${f.findings.filter((x) => x.kind === k).length} ${k}`);
  return { actions, wake: { afterMs: 30 * MIN }, note: counts.join(', ') };
},
```

## In the simulation

The world has four services, each with two test suites and a daily release. A seed picks one draw of breakages, flaky tests and canary alerts.

| Variant | What to watch |
| --- | --- |
| A month on call | Reverts, quarantines and paused releases, each with one issue for its owner; reverting the next suspect when the first was innocent |
| A quarter on call | Ninety days with flat memory; ignored issues escalated to the lead |
