# Large-scale migration

A campaign moves a large codebase from an old UI framework to a new one, component by component, over months. One loop runs the campaign and starts a child loop for each component.

## The job

A company decides to leave an old front-end framework. The codebase has hundreds or thousands of components, owned by dozens of teams. A codemod converts most of them. The rest is a long tail of real work:
- tests that break;
- screenshots that no longer match;
- components that someone is editing while the migration runs;
- a few that only their own team can convert.

Campaigns like this usually take months and a dedicated team, who track them in spreadsheets and nag owners for reviews. When the last component has moved, someone removes the bridge code between the two frameworks and deletes the old one.

## What makes it hard

- **Order matters.** A component can't move until the old-framework components it uses have moved.
- **Teams have limited review capacity.** Send a team twenty changes at once and they review none of them.
- **The long tail needs people.** Some components never convert cleanly, and their team has to do it with context from what was tried.
- **The codebase keeps moving.** People edit components mid-migration, migrate some by hand, and would keep writing new code on the old framework if nothing stopped them.
- **It runs for months.** The state of the campaign has to survive restarts, upgrades and changes of plan.

## How the loop sees the work

The work is split across two levels of loops.

**The campaign loop**
- **Goal:** no component is left on the old framework, and the cleanup has run.
- **What it reads:** code search and the build graph. That gives it each remaining component, its owner, what it uses and when it last changed. It also reads the migrations in progress and an allowlist of the paths still allowed on the old framework.
- **Findings:** `legacy:<path>`, one per component still on the old framework.
- **Blockers:** a migration in progress covers its component. `needs:<dependency>` is a prerequisite: the component waits until the components it uses have moved.
- **What it does:** start a child loop for each ready component, within work-in-progress limits, smallest first. Shrink the allowlist as components move. Once nothing is left, run the cleanup.

**The component loop**
- **Goal:** this component is off the old framework, submitted by the agent or migrated by a person.
- **Findings:** not converted yet; changed under the conversion; a failing build, test or screenshot comparison; a reviewer's comment.
- **Blockers:** waiting on the reviewer, or the component's team, once it has been escalated to them.
- **What it does:** convert, verify, request review, address comments, submit.

## What the architecture gives you here

- **Progress comes from the codebase.** The campaign's view is code search, so its burn-down is always true. A component someone migrated by hand is simply seen as gone.
- **Order without a schedule.** Prerequisites are blockers read from the build graph. A component becomes ready the moment its dependencies land, and time spent waiting doesn't count toward its age.
- **Limits are pure policy.** "At most four in flight, two per team, smallest first" is a few lines in `plan`. It can be tested against a snapshot of the real codebase before the campaign starts, and changing it changes nothing else.
- **Nesting keeps each loop small.** The campaign never sees review comments. It sees one blocker per component until the component is gone. Each child keeps its own attempts and judgments, so no single loop's memory grows with the size of the codebase. For a very large migration, add a level with one loop per team.
- **The long tail goes to people, with notes.** A child that runs out of attempts escalates the component to its team, with notes from what it tried. The campaign sees the team's work as a blocker like any other.
- **Edits mid-migration are handled.** If the component changes while its migration is in review, that conflict is a new finding: the agent converts again on the new code.

One caution. Each edit gives the conflict a fresh set of attempts. A component that someone edits every day could be converted again and again until the campaign's age limit. A count of conversions per component would catch this sooner.

## In the simulation

The sample app has 14 components owned by four teams. Most convert with the codemod, but several are harder:
- tests that fail twice before the agent gets them right;
- a visual diff to fix;
- a date picker whose screenshot never matches, so its team migrates it;
- a cart that someone edits while its migration is in review;
- a settings page a person migrates by hand before the campaign gets to it.

| Variant | What to watch |
| --- | --- |
| Balanced limits | Four in flight, two per team; components wait on their dependencies, then start |
| Wide open | Eight in flight, four per team: faster, with more review load on each team |
| One at a time | A single migration at a time, with every other rule unchanged |
