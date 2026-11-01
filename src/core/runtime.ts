/**
 * The narrow port the reconciler needs from a durable-execution engine.
 * Activities are NOT part of the port: specs receive their activities as an
 * injected object (in Temporal: `proxyActivities<Acts>()`; in tests: fakes).
 */
export type WakeReason = { reason: 'timeout' } | { reason: 'signal'; name: string };

export interface Runtime {
  readonly workflowId: string;
  /** Deterministic workflow time. */
  now(): number;
  /** Durable wait: returns on timeout, or early when one of `signals` arrives. */
  wait(opts: { timeoutMs: number; signals?: string[] }): Promise<WakeReason>;
  /**
   * Start a child workflow that OUTLIVES this one (parent-close = abandon).
   * Idempotent by workflowId: returns 'exists' if one is already running.
   */
  startChild(req: { workflowId: string; workflow: string; input: unknown }): Promise<'started' | 'exists'>;
  /** True when the engine suggests continuing as new because history is getting large. Checked every tick. */
  historyLarge?(): boolean;
  /** Best-effort hint to another workflow. Never required for correctness. */
  hint(workflowId: string, signal: string): Promise<void>;
}

export class Terminated extends Error {
  constructor(id: string) {
    super(`workflow ${id} terminated`);
  }
}
