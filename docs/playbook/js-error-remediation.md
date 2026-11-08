# Applying the playbook: JavaScript error remediation

A loop that watches the JavaScript errors your users hit in production, fixes the ones it can and hands the rest to people. This note goes through the playbook's phases with what is specific to this kind of work.

## The job

An error tracker collects errors thrown in users' browsers and groups them. For each group worth fixing, the work runs from triage, through a fix, review, merge and deploy, to confirming that the error has stopped. Errors that can't be fixed in your code are muted or handed to an owner. The work never finishes: every release brings new errors.

## What makes it hard

The playbook's general rules apply, but this domain hides several traps that a generic rule doesn't make obvious.

- **Stack traces change with every deploy.** Production bundles are minified, chunk file names carry content hashes, and line and column numbers move whenever any code nearby changes. An id built from a raw stack trace is new after every release, so the loop sees each deploy as a fresh set of errors and loses every attempt count.
- **Old code keeps running after the fix ships.** Browser tabs stay open for days, and cached bundles and service workers serve old code long after a deploy. The error keeps arriving from old releases. Measured across all releases, the fix looks like it failed, and the loop tries again.
- **Confirming a fix takes traffic.** An error that fired 500 times a day is clearly gone after an hour of silence. One that fired twice a week needs weeks of silence before its absence means anything.
- **Some errors aren't yours.** Browser extensions, injected third-party scripts, bots, very old browsers and flaky networks all throw errors that no change to your code will stop. A loop that tries to fix them burns its attempts and escalates noise.
- **Someone else's deploy may fix it, or break it again.** Another team's change can stop the error, make it look stopped by moving it to a different group, or bring it back. The loop must read what happened, never credit itself.
- **The fix can cause new errors.** A fix that throws somewhere else shows up as a new group, first seen in the fix's release, not as the old error coming back.
- **Groups merge and split.** People merge duplicate groups in the error tracker, and grouping rules change. A group id that looked stable can disappear.

## Phase 1: Survey

A remediation workflow on a durable engine typically keeps values like these between steps. Each needs a row in the survey table:

| Stored value | Which system owns that fact | Becomes |
| --- | --- | --- |
| Error group id | The error tracker | Part of the finding id, if it is stable enough (see phase 2) |
| Fix PR number and state | The code host | A read, found by a label or branch name |
| "Waiting for deploy" | The deploy system | A read: which deployed release contains the fix commit |
| Deployed release and rollout percentage | The deploy system, or the error tracker's release data | A read |
| Retry counter | Nobody else | The ledger's attempt count |
| "Muted" or "not ours" | The error tracker's group status | A read |
| Owner's bug | The issue tracker | A read, found by a label |

The systems are usually the error tracker, source maps and symbolication, the code host and CI, the deploy or release system, and the issue tracker, sometimes with feature flags. For each, note the lag: error events reach the tracker within minutes, a merged PR reaches production on the next release, and release adoption among users takes days.

## Phase 2: Design

**Unit of work.** This is usually two loops, like the migration example. A fleet loop never finishes. It reads the error tracker, picks which groups to work on and starts a loop per error, under a cap on fixes in flight. Each per-error loop has a goal and ends when the error is confirmed gone, muted or handed to an owner.

**Finding ids.** Build the id from what survives a deploy:

- the error type and a normalized message, with numbers, ids, URLs and quoted values stripped;
- the top few frames in your own code, after source mapping, as file path and function name, without line or column numbers.

Leave out bundle names, chunk hashes, line and column numbers, the browser and the release. The error tracker's group id can stand in for this if its grouping already works on source-mapped frames. If you use it, read the tracker's merge history, so a merged group keeps its finding.

Keep examples of the same error from two releases as fixtures, and test that both produce the same id.

**The goal, per error.** All three must hold:

1. a release containing the fix commit is deployed to all of production;
2. enough traffic runs on that release or later ones;
3. the error's count on those releases stays at zero, or below a baseline, for a window sized to how often it used to fire.

Count only events from releases that contain the fix. Events from older releases are expected, so they are not evidence that the fix failed.

To size the window: if the error fired `n` times a day and a share `s` of traffic runs fixed releases, a fix that didn't work would show about `n × s` events a day. Wait until that expected count reaches about five, so roughly `5 / (n × s)` days. For an error that fired 500 times a day, at 80% adoption, that is about 20 minutes. For one that fired twice a week, it is about three weeks, and the loop should say so rather than claim a quick win.

**Triage, as typed outcomes.** An agent classifies each new error into one of a few labels, and `plan` maps each label to actions:

| Triage label | What the loop does |
| --- | --- |
| Fixable in our code | An agent writes a fix with a test that reproduces the error, and opens a PR |
| Needs an owner | Files a bug for the owning team, labeled with the finding id |
| Not ours | Mutes the group with a reason: an extension, a third-party script, a bot, an unsupported browser |
| Expected | Mutes it, or marks it handled: a network failure or a user's cancelled request |
| Duplicate | Points it at the finding that already covers it |

**Markers.** Put the finding id on everything the loop creates: a PR label, a branch name such as `remediation/<finding id>`, and a commit trailer such as `Fixes-Error: <finding id>`. The trailer matters most: it lets the loop find which deployed release contains the fix by searching commits, without remembering anything.

**Blockers.** An open fix PR, a merged fix not yet in a deployed release, a release still rolling out, and an open bug with an owner. Each names the finding it covers.

**Verifying the agent's fix.** The fix is bounded work, and something other than the agent checks it: the new test fails before the change and passes after it, CI is green, and a person reviews it. Decide in this phase whether the loop may ever merge on its own. Most teams start with a person merging.

**A fix that causes new errors.** Watch for new groups first seen in the fix's release whose frames touch files the fix changed. Each is a finding of its own, tied to the fix: the mitigation is reverting the fix, and the delegation is reopening the original error.

**Limits.** Usually a cap on open fix PRs, an attempt limit per error of two or three fixes, and an age limit sized to the confirmation window. Escalations go to the owning team, with the error, the fixes tried and why each was judged not to work.

## Phase 3: Read side

- **Missing source maps make the id unknown.** If a release's source maps haven't been uploaded yet, or failed to upload, its frames can't be mapped, and the finding id can't be computed. Treat the id as unknown and hold. Don't create a finding from minified frames: it would be a duplicate with a drifting id.
- **Counts are sampled.** Many error trackers sample events at high volume. Read counts with the sample rate and scale them, or the confirmation window comes out wrong.
- **A count of zero and a failed query are different results.** "No events on the fixed release" is the evidence that ends the loop, so it must never be produced by a timeout, a rate limit or a query that ran before the release existed in the tracker.
- **Read release adoption,** the share of traffic on each release, from the tracker's session data or from the deploy system. The goal depends on it.
- **Record fixtures** of real events with personal data removed: minified and source-mapped versions of the same error, events from extensions, old browsers and bots, merged groups, and releases without source maps.
- **Fakes need** release adoption that rises over days while old tabs fade, noisy sampled counts, deploy delays, a person fixing the same error by hand, a group merged mid-run, and a fix that moves the error instead of stopping it.

## Phase 4: Shadow

- **Replay history.** Error trackers keep weeks of data. Feed past data through the pure parts and look for errors the loop would have declared fixed that came back, and for ids that changed between releases.
- **Count ids per real error** across at least two releases. One id per error is the target.
- **Compare triage with what people decided.** If the old workflow or people muted, fixed or assigned the same errors, every disagreement is either a triage bug or a judgment worth a second look.

## Phase 5: Actions

In this domain, the usual order is:

1. comments on error groups;
2. muting groups judged not ours;
3. filing bugs for owners;
4. opening fix PRs as drafts;
5. marking PRs ready and requesting review;
6. merging, if a person ever lets the loop do it;
7. reverting a fix that causes new errors.

Split the work with the existing workflow by project or by a tag on error groups, so no error is handled by both.

## Phase 6: Cutover

The old workflow's open PRs and bugs won't carry the new markers. Backfill the label and the finding id on each, or the loop won't see them and will write a second fix for the same error.
