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

## In the simulation

The world has four services, each with two test suites and a daily release. A seed picks one draw of breakages, flaky tests and canary alerts.

| Variant | What to watch |
| --- | --- |
| A month on call | Reverts, quarantines and paused releases, each with one issue for its owner; reverting the next suspect when the first was innocent |
| A quarter on call | Ninety days with flat memory; ignored issues escalated to the lead |
