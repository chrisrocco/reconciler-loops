import type {
  Action, Blocker, Budget, EscalateAction, Escalation, Finding, FindingId, Frame, IntentRecord,
  LoopMemory, Memo, Observation, Outcome, ReconcilerSpec, TickRecord,
} from './types.js';
import type { Runtime } from './runtime.js';
import { HOUR } from './time.js';

export interface ReconcileOptions {
  /** Resume from a previous run (continue-as-new) or a previous loop entirely. v1 memory is migrated. */
  memory?: LoopMemory | LoopMemoryV1;
  /** Return `checkpoint` after this many ticks so the caller can continue-as-new. */
  maxTicksPerRun?: number;
  /**
   * After a tick that acted, look again immediately at most this many ticks in a row;
   * after that, honor the plan's wake. A plan that keeps issuing fresh keys against a
   * world that never changes (e.g. a tick-keyed repair) then polls instead of spinning
   * with no time passing. Default 10.
   */
  maxImmediateTicks?: number;
  onTick?: (rec: TickRecord) => void;
}

/** Forgotten-entry counts are dropped after this many retention periods without activity. */
const FORGET_FINDING_AFTER_PERIODS = 10;
const DEFAULT_ESCALATION_DEADLINE_MS = HOUR;

export function newMemory(now: number): LoopMemory {
  return { version: 2, startedAt: now, tick: 0, intents: [], forgotten: {}, memo: {}, facts: {} };
}

// #region tick
/**
 * Drive the world toward `spec.done` by repeated observe → done? → plan → act → wait.
 * Findings the loop can't resolve are escalated one at a time, and the loop carries on.
 * It ends only when the goal is met, it runs out of time, or the plan says stop.
 * Callable from anywhere inside a workflow; returns an Outcome the caller composes on.
 */
export async function reconcile<W, F extends Finding, A extends Action, J = never>(
  rt: Runtime,
  spec: ReconcilerSpec<W, F, A, J>,
  opts: ReconcileOptions = {},
): Promise<Outcome<W, F>> {
  const mem: LoopMemory = opts.memory ? migrate(opts.memory, rt.now()) : newMemory(rt.now());
  const budget = spec.budget ?? {};
  const memo = memoOver(mem, rt);
  let runTicks = 0;
  let actingStreak = 0;
  let woke: string | undefined = mem.tick === 0 ? 'start' : 'resume';

  for (;;) {
    const now = rt.now();
    const ctx = { now, tick: mem.tick, memo, facts: mem.facts };

    // 1. OBSERVE — facts from systems of record; the frame adds the ledger, sorts the
    // findings, and picks out the ones to hand to a person.
    forget(mem, now, budget);
    const obs = await spec.observe(ctx);
    let frame = buildFrame<W, F, J>(obs, mem, now, budget);

    // 2. GOAL MET? Checked first, so a loop that succeeded is never reported as out of time.
    const doneReason = spec.done?.(frame);
    if (doneReason) return { status: 'done', reason: doneReason, frame, memory: mem };

    // 3. OUT OF TIME? Only finite loops have a time budget. Checked against the lineage.
    const late = outOfTime(mem, now, budget);
    if (late) return { status: 'out-of-time', reason: late, frame, memory: mem };

    // 4. ASSESS — memoized judgments on open findings only.
    if (spec.assess && frame.open.length) {
      const assessments = await spec.assess(frame.open, { ...ctx, attempts: frame.attempts });
      frame = { ...frame, assessments };
    }

    // 5. PLAN — pure.
    const plan = spec.plan(frame);

    // 6. ACT — the loop's escalations first, then the plan's actions; never repeat a key.
    const act = (actions: (A | EscalateAction)[]) => runActions(actions, mem, rt, (a) => spec.act(a, frame, mem.facts));
    const { acted, skipped } = await act([...frame.escalating.map((e) => escalation(e, frame, budget)), ...plan.actions]);

    // REPEATING ITSELF — an open finding whose every proposed action was already taken can
    // never be acted on again (the plan is pure and the ledger never repeats a key). A key
    // is missing its attempt number: hand the finding to a person and report it.
    const stalled = stalledFindings(plan.actions, skipped, frame);
    if (stalled.length) {
      const reason = 'the plan only repeats actions already taken';
      acted.push(...(await act(stalled.map((f) => escalation({ finding: f, reason }, frame, budget)))).acted);
    }

    opts.onTick?.({
      loop: spec.name, tick: mem.tick, at: now,
      findings: ids(frame.findings), open: ids(frame.open), blocked: ids(frame.blocked),
      claimed: ids(frame.claimed), escalating: ids(frame.escalating.map((e) => e.finding)),
      stalled: ids(stalled), blockers: frame.blockers.map((b) => b.id), held: frame.held,
      acted, skipped, note: plan.note, woke,
    });
    mem.tick += 1;
    runTicks += 1;

    // 7. TOLD TO STOP? Only after acting, so a safety rollback in the same plan still runs.
    if (plan.halt) return { ...plan.halt, frame, memory: mem };

    // 8. WAIT — if we changed the world, look again now (up to maxImmediateTicks in a row);
    // otherwise sleep until poll/hint.
    actingStreak = acted.length ? actingStreak + 1 : 0;
    if (acted.length && actingStreak <= (opts.maxImmediateTicks ?? 10)) {
      woke = 'acted';
    } else {
      const r = await rt.wait({ timeoutMs: plan.wake.afterMs, signals: plan.wake.signals });
      woke = r.reason === 'signal' ? `signal:${r.name}` : 'timeout';
    }

    // #region checkpoint
    // 9. CHECKPOINT — bound history; everything needed to resume is in `mem`.
    if ((opts.maxTicksPerRun && runTicks >= opts.maxTicksPerRun) || rt.historyLarge?.()) return { status: 'checkpoint', memory: mem };
    // #endregion
  }
}
// #endregion

// ───────────────────────────── frame construction ─────────────────────────────

/**
 * Combine an observation with the ledger: settle actions in flight, sort findings into
 * open / claimed / blocked, count attempts, and pick out findings to escalate.
 */
export function buildFrame<W, F extends Finding, J = never>(
  obs: Observation<W, F>, mem: LoopMemory, now: number, budget: Budget = {},
): Frame<W, F, J> {
  // #region sort
  const covered = new Set(obs.blockers.flatMap((b) => b.on));
  for (const it of mem.intents) if (!it.settled) settleIntent(it, covered, now);

  const claimedIds = new Set(mem.intents.filter((i) => !i.settled).flatMap((i) => i.targets));
  const blocked: F[] = [];
  const claimed: F[] = [];
  const unhandled: F[] = [];
  for (const f of obs.findings) {
    if (covered.has(f.id)) blocked.push(f);
    else if (claimedIds.has(f.id)) claimed.push(f);
    else unhandled.push(f);
  }
  // #endregion

  const attempts: Record<FindingId, number> = {};
  for (const [id, f] of Object.entries(mem.forgotten)) attempts[id] = f.count;
  for (const it of mem.intents) for (const t of it.targets) attempts[t] = (attempts[t] ?? 0) + 1;

  const escalating: Escalation<F>[] = [];
  for (const f of [...unhandled, ...blocked]) {
    const reason = escalationReason(f, covered.has(f.id), mem, obs.blockers, now, budget);
    if (reason) escalating.push({ finding: f, reason });
  }
  const escalatingIds = new Set(escalating.map((e) => e.finding.id));

  return {
    tick: mem.tick, now, startedAt: mem.startedAt, world: obs.world,
    findings: obs.findings, open: unhandled.filter((f) => !escalatingIds.has(f.id)), blocked, claimed, escalating,
    blockers: obs.blockers, held: obs.blockers.some((b) => b.scope === 'loop'),
    attempts, assessments: {} as Record<FindingId, J>,
  };
}

/**
 * Lifecycle of an action that shows up later:
 *   waiting ──(blocker for a target seen)──▶ handed off ──(blocker gone)──▶ settled
 *      └──────────(deadline, never seen)──────────────────────────────────▶ settled (lost)
 */
function settleIntent(it: IntentRecord, covered: Set<FindingId>, now: number) {
  if (it.deadlineMs === undefined) it.settled = true;
  else if (it.targets.some((t) => covered.has(t))) it.handedOff = true;
  else if (it.handedOff) it.settled = true;
  else if (now - it.at > it.deadlineMs) it.settled = true;
}

/** Why a finding should go to a person now, if it should. */
function escalationReason(
  f: Finding, blocked: boolean, mem: LoopMemory, blockers: Blocker[], now: number, budget: Budget,
): string | undefined {
  if (f.severity !== 'blocking') return undefined;
  const mine = mem.intents.filter((i) => i.targets.includes(f.id));
  if (mine.some((i) => i.kind === 'escalate' && !i.settled)) return undefined; // already with a person

  // Out of attempts: counted since the last escalation, so a person's answer buys fresh attempts.
  const lastEscalation = mine.filter((i) => i.kind === 'escalate').at(-1);
  const since = mine.filter((i) => i.kind !== 'escalate' && (!lastEscalation || i.at > lastEscalation.at));
  if (!blocked && budget.maxAttemptsPerFinding !== undefined && since.length >= budget.maxAttemptsPerFinding)
    return `still unresolved after ${since.length} attempts`;

  // Too old: counts from when real work began — the loop's first action, or an obligation
  // someone owns. Waiting on a prerequisite, or in a queue the loop hasn't acted on, doesn't count.
  if (budget.maxFindingAgeMs !== undefined) {
    const owned = blockers.filter((b) => b.on.includes(f.id) && !b.prerequisite && b.since !== undefined).map((b) => b.since!);
    const start = lastEscalation?.at ?? Math.min(mine[0]?.at ?? Infinity, ...owned);
    if (Number.isFinite(start) && now - start > budget.maxFindingAgeMs)
      return `unresolved for ${Math.round((now - start) / (24 * HOUR))} days`;
  }
  return undefined;
}

/** The escalate action for a finding. Its key carries the next attempt number, like any retry. */
export function escalation<F extends Finding>(e: Escalation<F>, frame: Frame<unknown, F, any>, budget: Budget = {}): EscalateAction {
  return {
    kind: 'escalate',
    key: `escalate:${e.finding.id}:${(frame.attempts[e.finding.id] ?? 0) + 1}`,
    targets: [e.finding.id],
    deadlineMs: budget.escalationDeadlineMs ?? DEFAULT_ESCALATION_DEADLINE_MS,
    finding: e.finding.id,
    reason: e.reason,
  };
}

function outOfTime(mem: LoopMemory, now: number, b: Budget) {
  return b.maxDurationMs !== undefined && now - mem.startedAt >= b.maxDurationMs ? 'exceeded maxDurationMs' : undefined;
}

// ───────────────────────────── ledger ─────────────────────────────

// #region run-actions
/** Perform each action whose key the ledger hasn't seen, and record it. */
async function runActions<A extends Action>(actions: A[], mem: LoopMemory, rt: Runtime, perform: (a: A) => Promise<void>) {
  const spent = new Set(mem.intents.map((i) => i.key));
  const acted: string[] = [];
  const skipped: string[] = [];
  for (const a of actions) {
    if (spent.has(a.key)) { skipped.push(a.key); continue; }
    await perform(a);
    mem.intents.push({
      key: a.key, kind: a.kind, targets: a.targets ?? [], at: rt.now(), tick: mem.tick,
      deadlineMs: a.deadlineMs, settled: a.deadlineMs === undefined,
    });
    spent.add(a.key);
    acted.push(a.key);
  }
  return { acted, skipped };
}
// #endregion

/** Open blocking findings whose every proposed action was already in the ledger. */
function stalledFindings<F extends Finding>(actions: Action[], skipped: string[], frame: Frame<unknown, F, any>): F[] {
  const s = new Set(skipped);
  return frame.open.filter((f) => {
    if (f.severity !== 'blocking') return false;
    const proposed = actions.filter((a) => a.targets?.includes(f.id));
    return proposed.length > 0 && proposed.every((a) => s.has(a.key));
  });
}

/**
 * Retention: forget settled ledger entries and stored judgments older than the retention
 * period. Forgotten entries are kept as a count per finding, so attempt numbers (and the
 * keys built from them) never repeat.
 */
export function forget(mem: LoopMemory, now: number, b: Budget) {
  if (b.retentionMs === undefined) return;
  const cutoff = now - b.retentionMs;
  const keep: IntentRecord[] = [];
  for (const it of mem.intents) {
    if (!it.settled || it.at >= cutoff) { keep.push(it); continue; }
    for (const t of it.targets) {
      const f = (mem.forgotten[t] ??= { count: 0, lastAt: 0 });
      f.count += 1;
      f.lastAt = Math.max(f.lastAt, it.at);
    }
  }
  mem.intents = keep;

  const dropBefore = now - FORGET_FINDING_AFTER_PERIODS * b.retentionMs;
  for (const [id, f] of Object.entries(mem.forgotten))
    if (f.lastAt < dropBefore && !mem.intents.some((i) => i.targets.includes(id))) delete mem.forgotten[id];
  for (const [k, m] of Object.entries(mem.memo)) if (m.at < cutoff) delete mem.memo[k];
}

function memoOver(mem: LoopMemory, rt: Runtime): Memo {
  return {
    async get<T>(key: string, compute: () => Promise<T>): Promise<T> {
      const hit = mem.memo[key];
      if (hit) return hit.value as T;
      const value = await compute();
      mem.memo[key] = { value, at: rt.now() };
      return value;
    },
  };
}

// ───────────────────────────── memory versions ─────────────────────────────

/** Memory as written before escalation and retention (handoff TTLs, bare memo values, spend counters). */
export interface LoopMemoryV1 {
  version: 1;
  startedAt: number;
  tick: number;
  actions: number;
  cost: number;
  intents: (Omit<IntentRecord, 'deadlineMs'> & { settle: { kind: 'immediate' } | { kind: 'handoff'; ttlMs: number } })[];
  memo: Record<string, unknown>;
}

/** Read memory of any version as the current one. Stored judgments from v1 are stamped `now`. */
export function migrate(m: LoopMemory | LoopMemoryV1, now: number): LoopMemory {
  if (m.version === 2) return { ...m, facts: m.facts ?? {} };
  return {
    version: 2, startedAt: m.startedAt, tick: m.tick, forgotten: {}, facts: {},
    intents: m.intents.map(({ settle, ...it }) => ({ ...it, deadlineMs: settle.kind === 'handoff' ? settle.ttlMs : undefined })),
    memo: Object.fromEntries(Object.entries(m.memo).map(([k, value]) => [k, { value, at: now }])),
  };
}

const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

// ───────────────────────────── composition helper ─────────────────────────────

/**
 * Run a reconciler to a terminal outcome, continuing-as-new on checkpoints.
 * In Temporal, replace the loop body with `continueAsNew({ ...input, memory })`.
 */
export async function reconcileToEnd<W, F extends Finding, A extends Action, J>(
  rt: Runtime,
  spec: ReconcilerSpec<W, F, A, J>,
  opts: RunOptions = {},
): Promise<Exclude<Outcome<W, F>, { status: 'checkpoint' }>> {
  let memory = opts.memory;
  for (;;) {
    const out = await reconcile(rt, spec, { ...opts, memory });
    if (out.status !== 'checkpoint') return out;
    opts.onCheckpoint?.(out.memory);
    memory = JSON.parse(JSON.stringify(out.memory)); // proves memory survives serialization
  }
}

export type RunOptions = ReconcileOptions & { onCheckpoint?: (m: LoopMemory) => void };
