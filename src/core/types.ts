/**
 * Reconciler core types.
 *
 * The loop is LEVEL-TRIGGERED: every tick re-derives the full picture from the
 * world (systems of record), never from accumulated in-memory events. The only
 * state the loop owns is `LoopMemory` — a small, JSON-serializable ledger of
 * actions it has taken and memoized judgments. Everything else (findings,
 * blockers, progress) is observed.
 */

// ───────────────────────────── Findings & blockers ─────────────────────────────

export type FindingId = string;

/** Something wrong with the world that the loop must drive to resolution. */
export interface Finding<K extends string = string, D = unknown> {
  /** Stable fingerprint. Same underlying problem ⇒ same id on every tick. */
  id: FindingId;
  kind: K;
  /** `blocking` findings prevent convergence; `advisory` ones don't. */
  severity: 'blocking' | 'advisory';
  summary: string;
  data: D;
}

/**
 * A pending obligation *observed in the world* — a child bug that is still
 * open, a CL that hasn't reached prod, a draft awaiting human approval.
 *
 * Blockers are never stored by the loop: they are re-observed every frame from
 * the system that owns them. That is what lets a human close the bug by hand,
 * or a brand-new workflow pick the loop up mid-flight.
 */
export interface Blocker {
  /** Stable id, e.g. `bug:B-12`, `deploy:cl/77`. */
  id: string;
  kind: string;
  /** Findings this blocker is handling. Those findings are not re-acted on. */
  on: FindingId[];
  /** `loop` also holds the whole loop; `finding` covers only `on`. */
  scope: 'loop' | 'finding';
  summary: string;
  /** When the obligation began, if the world says. A finding's age counts from here. */
  since?: number;
  /**
   * Set when this blocker means "something else must happen first" (another finding
   * resolved, a dependency migrated), not "someone is working on it". It covers `on`
   * the same way, but waiting on it does not count toward the finding's age.
   */
  prerequisite?: boolean;
}

// ───────────────────────────── Actions & plans ─────────────────────────────

export interface Action<K extends string = string> {
  /**
   * Deterministic from the frame (e.g. `fix:breach:latency:2`). The loop never
   * performs the same key twice in a lineage, and effects should be idempotent
   * on this key at the destination too.
   */
  key: string;
  kind: K;
  /** Findings this action addresses. Each one counts as an attempt on them. */
  targets?: FindingId[];
  /**
   * Set when the effect shows up in the world later, as a blocker (a filed bug, a
   * submitted CL). The targets stay *claimed* until that blocker is seen and then
   * clears — or this long passes with no sign of it, and the action is presumed lost.
   * Omit for actions that are finished when they return.
   */
  deadlineMs?: number;
}

/** The loop's own action for handing a finding to a person. Every spec's `act` must handle it. */
export interface EscalateAction extends Action<'escalate'> {
  targets: [FindingId];
  deadlineMs: number;
  finding: FindingId;
  reason: string;
}

/** A finding being handed to a person this tick, and why. */
export interface Escalation<F extends Finding = Finding> {
  finding: F;
  reason: string;
}

/** When to run the next tick if no actions were taken. */
export interface Wake {
  /** Poll interval. Observation is the source of truth, so this is required. */
  afterMs: number;
  /** Signals that wake the loop early. Signals are HINTS: they carry no state. */
  signals?: string[];
}

export type Halt = { status: 'escalated' | 'failed'; reason: string };

export interface Plan<A extends Action> {
  actions: A[];
  wake: Wake;
  /** Stop after running this plan's actions. The only way a plan ends the loop. */
  halt?: Halt;
  note?: string;
}

// ───────────────────────────── Frame ─────────────────────────────

export interface Observation<W, F extends Finding> {
  world: W;
  findings: F[];
  blockers: Blocker[];
}

/** One immutable snapshot handed to `done` and `plan`. Plain data. */
export interface Frame<W, F extends Finding, J = never> {
  tick: number;
  now: number;
  startedAt: number;
  world: W;
  /** Every finding observed this tick. */
  findings: F[];
  /** Findings nobody is handling: not blocked, not claimed, not being escalated. */
  open: F[];
  /** Findings a blocker in the world is handling. */
  blocked: F[];
  /** Findings an action in flight is handling, but the world doesn't show it yet. */
  claimed: F[];
  /**
   * Findings the loop hands to a person this tick (out of attempts, too old). Taken
   * out of `open`; the loop files the escalation, and `plan` may add a safety action.
   */
  escalating: Escalation<F>[];
  blockers: Blocker[];
  /** True if any loop-scoped blocker exists — forward progress must wait. */
  held: boolean;
  /** Ledger entries per finding over the whole lineage, forgotten ones included. The next attempt is this + 1. */
  attempts: Record<FindingId, number>;
  /** Memoized judgments (classification, triage) for open findings. */
  assessments: Record<FindingId, J>;
}

// ───────────────────────────── Memory (the only owned state) ─────────────────────────────

export interface IntentRecord {
  key: string;
  kind: string;
  targets: FindingId[];
  at: number;
  tick: number;
  deadlineMs?: number;
  /** A blocker for the targets has been seen. */
  handedOff?: boolean;
  settled: boolean;
}

export interface LoopMemory {
  version: 2;
  startedAt: number;
  tick: number;
  /** The ledger. */
  intents: IntentRecord[];
  /** Ledger entries dropped by retention, as a count per finding, so attempt numbers never repeat. */
  forgotten: Record<FindingId, { count: number; lastAt: number }>;
  /** Stored agent judgments. */
  memo: Record<string, { value: unknown; at: number }>;
  /**
   * Named facts the world cannot show, such as which experiment this loop manages. Keep them
   * few and safe to lose: retention never forgets them, but a fresh loop starts without them.
   */
  facts: Facts;
}

export type Facts = Record<string, string | number | boolean | undefined>;

// ───────────────────────────── Budget & outcome ─────────────────────────────

export interface Budget {
  /** Finite loops only: stop (safe hold) after this long. Omit for loops that never end. */
  maxDurationMs?: number;
  /** Attempts on a finding before handing it to a person. Counted since its last escalation. */
  maxAttemptsPerFinding?: number;
  /** Hand a finding to a person if it stays unresolved (open or blocked) this long. */
  maxFindingAgeMs?: number;
  /** Forget settled ledger entries and stored judgments older than this. Omit to keep everything. */
  retentionMs?: number;
  /** How long an escalation may take to show up in the world. Default 1 hour. */
  escalationDeadlineMs?: number;
}

/** The only three ways a loop ends — goal met, out of time, told to stop — plus a checkpoint. */
export type Outcome<W, F extends Finding> =
  | { status: 'done'; reason: string; frame: Frame<W, F, any>; memory: LoopMemory }
  | { status: 'out-of-time'; reason: string; frame: Frame<W, F, any>; memory: LoopMemory }
  | { status: 'escalated' | 'failed'; reason: string; frame: Frame<W, F, any>; memory: LoopMemory }
  /** Ran `maxTicksPerRun` ticks (or history got large); caller should continue-as-new with `memory`. */
  | { status: 'checkpoint'; memory: LoopMemory };

// ───────────────────────────── Spec ─────────────────────────────

/** Memoize an expensive judgment (LLM call) by content key, persisted in LoopMemory. */
export interface Memo {
  get<T>(key: string, compute: () => Promise<T>): Promise<T>;
}

export interface ObserveCtx {
  now: number;
  tick: number;
  memo: Memo;
  facts: Readonly<Facts>;
}

/**
 * A reconciler is up to five functions. Only `done` and `plan` must be pure;
 * `observe`, `assess` and `act` call activities.
 */
export interface ReconcilerSpec<W, F extends Finding, A extends Action, J = never> {
  name: string;
  /** Read the systems of record. Derive findings and blockers from them. */
  observe(ctx: ObserveCtx): Promise<Observation<W, F>>;
  /** Optional judgment pass over OPEN findings only (memoized). e.g. classify, triage. */
  assess?(open: F[], ctx: ObserveCtx & { attempts: Record<FindingId, number> }): Promise<Record<FindingId, J>>;
  /** Pure. Return a reason string when the goal is met. Left out for a loop that never finishes. */
  done?(frame: Frame<W, F, J>): string | undefined;
  /** Pure. Decide the next actions from this frame alone. */
  plan(frame: Frame<W, F, J>): Plan<A>;
  /** Perform one action as one idempotent effect, including the loop's own escalations. The only place facts are written. */
  act(action: A | EscalateAction, frame: Frame<W, F, J>, facts: Facts): Promise<void>;
  budget?: Budget;
}

// ───────────────────────────── Trace ─────────────────────────────

export interface TickRecord {
  loop: string;
  tick: number;
  at: number;
  findings: FindingId[];
  open: FindingId[];
  blocked: FindingId[];
  claimed: FindingId[];
  escalating: FindingId[];
  /** Open findings whose every proposed action was already taken: a key is missing its attempt number. */
  stalled: FindingId[];
  blockers: string[];
  held: boolean;
  acted: string[];
  skipped: string[];
  note?: string;
  woke?: string;
}
