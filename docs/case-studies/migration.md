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

## The code

Both loops are in `src/scenarios/migration.ts`. The campaign's types say what it sees, what can be wrong, and what it can do:

<!-- source: src/scenarios/migration.ts#campaign-types -->
```ts
interface CampaignWorld {
  legacy: LegacyComponent[]; changes: MigrationChange[]; allowlist: string[];
  cleanup: 'not-started' | 'running' | 'done'; children: Record<string, WorkflowStatus>;
}
type CampaignFinding = Finding<'legacy', LegacyComponent> | Finding<'allowlist-stale', string[]>;
type CampaignAction =
  | { key: string; kind: 'start-migration'; targets: string[]; path: string; deadlineMs: number }
  | { key: string; kind: 'restart-migration'; path: string }
  | { key: string; kind: 'shrink-allowlist'; targets: string[]; paths: string[] }
  | { key: string; kind: 'cleanup' };
```

The campaign reads code search, the open migration changes and the allowlist. A migration in progress covers its component. Each old-framework component a component still uses is a prerequisite blocker, which never counts toward its age:

<!-- source: src/scenarios/migration.ts#campaign-observe -->
```ts
async observe() {
  const [legacy, changes, allowlist, cleanup] = await Promise.all([acts.listLegacy(), acts.listChanges(self), acts.getAllowlist(), acts.cleanupState()]);
  const open = changes.filter((c) => c.state === 'open');
  const children = Object.fromEntries(await Promise.all(open.map(async (c) => [c.path, await acts.workflowStatus(migrationId(c.path))] as const)));
  const remaining = new Set(legacy.map((c) => c.path));
  const findings: CampaignFinding[] = legacy.map((c) => ({ id: `legacy:${c.path}`, kind: 'legacy', severity: 'blocking', summary: `${c.path} (${c.lines} lines, ${c.owner})`, data: c }));
  const stale = allowlist.filter((p) => !remaining.has(p));
  if (stale.length) findings.push({ id: 'allowlist-stale', kind: 'allowlist-stale', severity: 'advisory', summary: `${stale.length} migrated paths still allowlisted`, data: stale });
  const blockers: Blocker[] = [
    ...open.map((c) => ({ id: `migration:${c.id}`, kind: c.withTeam ? 'team' : 'migration', on: [`legacy:${c.path}`], scope: 'finding' as const, summary: c.withTeam ? `with ${c.owner}` : `migrating (${c.review})`, since: c.withTeam?.since ?? c.createdAt })),
    // Prerequisites: wait for the old-framework components this one uses. These never age.
    ...legacy.flatMap((c) => c.uses.filter((d) => remaining.has(d)).map((d) => ({ id: `needs:${d}`, kind: 'prerequisite', on: [`legacy:${c.path}`], scope: 'finding' as const, summary: `${c.path} uses ${d}`, prerequisite: true }))),
  ];
  return { world: { legacy, changes, allowlist, cleanup, children }, findings, blockers };
},
```

The work-in-progress limits are plain code in `plan`: smallest first, at most so many in flight overall and per team. Findings beyond the limits stay open and untouched until there's room:

<!-- source: src/scenarios/migration.ts#campaign-plan -->
```ts
plan(f) {
  const { legacy, changes, children, cleanup } = f.world;
  const actions: CampaignAction[] = [];
  const open = changes.filter((c) => c.state === 'open');

  // 1. Repair: a migration in progress whose child loop died (not one its team has).
  for (const c of open) if (!c.withTeam && (children[c.path] === 'unknown' || children[c.path] === 'terminated'))
    actions.push({ key: `restart:${c.path}@${f.tick}`, kind: 'restart-migration', path: c.path });

  // 2. Respond, within work-in-progress limits: smallest first. The rest stay open, untouched.
  // Claimed findings count as in flight too: their child has started but its change isn't listed yet.
  const claimed = f.claimed.flatMap((x) => (x.kind === 'legacy' ? [x.data] : []));
  let inFlight = open.filter((c) => !c.withTeam).length + claimed.length;
  const perOwner: Record<string, number> = {};
  for (const c of [...open.filter((c) => !c.withTeam), ...claimed]) perOwner[c.owner] = (perOwner[c.owner] ?? 0) + 1;
  const ready = f.open.flatMap((x) => (x.kind === 'legacy' ? [x] : [])).sort((a, b) => a.data.lines - b.data.lines);
  for (const x of ready) {
    if (inFlight >= maxInFlight) break;
    if ((perOwner[x.data.owner] ?? 0) >= maxPerOwner) continue;
    actions.push({ key: `migrate:${x.data.path}:${(f.attempts[x.id] ?? 0) + 1}`, kind: 'start-migration', targets: [x.id], path: x.data.path, deadlineMs: HOUR });
    inFlight++;
    perOwner[x.data.owner] = (perOwner[x.data.owner] ?? 0) + 1;
  }
  const stale = f.open.find((x) => x.kind === 'allowlist-stale');
  if (stale) actions.push({ key: `allowlist:${legacy.length}`, kind: 'shrink-allowlist', targets: [stale.id], paths: legacy.map((c) => c.path) });

  // 3. Move forward: nothing left and nothing outstanding → remove the bridge and the old framework.
  if (!legacy.length && !f.blockers.length && !f.claimed.length && cleanup === 'not-started') actions.push({ key: 'cleanup', kind: 'cleanup' });
  return {
    actions, wake: { afterMs: 2 * HOUR, signals: ['child-closed'] },
    note: `${legacy.length} left, ${open.length} in flight, ${f.open.filter((x) => x.kind === 'legacy').length} ready`,
  };
},
```

The component loop verifies each patchset once (memoized by its revision) and puts the component's last change in the conflict's id, so an edit mid-review is a new finding:

<!-- source: src/scenarios/migration.ts#component-observe -->
```ts
async observe({ memo }) {
  const component = await acts.getComponent(input.path);
  const change = (await acts.listChanges(input.parent)).find((c) => c.path === input.path && c.state === 'open');
  if (!component) return { world: { change }, findings: [], blockers: [] };
  const findings: ComponentFinding[] = [];
  const blockers: Blocker[] = [];
  let checks: ComponentWorld['checks'];
  if (change?.withTeam) blockers.push({ id: `team:${input.path}`, kind: 'team', on: [], scope: 'loop', summary: `with ${change.owner}: ${change.withTeam.reason}`, since: change.withTeam.since });
  else if (!change || change.baseAt === undefined) findings.push({ id: 'unconverted', kind: 'unconverted', severity: 'blocking', summary: 'not converted yet', data: {} });
  // Changed underneath the conversion: a new finding, with fresh attempts — convert again on the new code.
  else if (change.baseAt < component.changedAt) findings.push({ id: `conflict@${component.changedAt}`, kind: 'conflict', severity: 'blocking', summary: 'the component changed since it was converted', data: {} });
  else {
    // Compiling is not the same as working: verify every patchset (once per patchset).
    checks = await memo.get(`verify:${change.id}@${change.rev}`, () => acts.verify(change.id));
    for (const [name, v] of Object.entries(checks)) if (v === 'fail')
      findings.push({ id: `check:${name}`, kind: 'check', severity: 'blocking', summary: `${name} failing`, data: { check: name as CheckName } });
    for (const c of change.comments.filter((c) => !c.resolved))
      findings.push({ id: `comment:${c.id}`, kind: 'comment', severity: 'blocking', summary: c.body, data: { commentId: c.id } });
    if (change.review === 'requested' && !change.comments.some((c) => !c.resolved))
      blockers.push({ id: `reviewer:${change.id}`, kind: 'reviewer', on: [], scope: 'loop', summary: `waiting on ${change.owner}`, since: change.requestedAt });
  }
  return { world: { component, change, checks }, findings, blockers };
},
```

<!-- source: src/scenarios/migration.ts#component-plan -->
```ts
plan(f) {
  const actions: ComponentAction[] = [];
  const n = (id: string) => (f.attempts[id] ?? 0) + 1;
  for (const x of f.open) {
    if (x.kind === 'unconverted' || x.kind === 'conflict') actions.push({ key: `convert:${x.id}:${n(x.id)}`, kind: 'convert', targets: [x.id] });
    if (x.kind === 'check') actions.push({ key: `fix:${x.id}:${n(x.id)}`, kind: 'fix-check', targets: [x.id], check: x.data.check! });
  }
  const comments = f.open.filter((x) => x.kind === 'comment');
  if (comments.length) {
    const ids = comments.map((x) => x.id).sort();
    actions.push({ key: `address:${ids.join(',')}:${Math.max(...ids.map(n))}`, kind: 'address', targets: ids, commentIds: comments.map((x) => x.data.commentId!) });
  }
  // Move forward on a clean frame: verified → ask for review; approved → submit.
  const c = f.world.change;
  if (c && !f.findings.length && !f.blockers.length && !f.claimed.length && f.world.checks) {
    if (c.review === 'none') actions.push({ key: `review:r${c.rev}`, kind: 'request-review' });
    if (c.review === 'approved') actions.push({ key: `submit:r${c.rev}`, kind: 'submit' });
  }
  return { actions, wake: { afterMs: f.held ? 4 * HOUR : HOUR }, note: c ? `r${c.rev} ${c.review}` : undefined };
},
```

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
