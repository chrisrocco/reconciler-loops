/**
 * Views of the systems of record shared by the experiment and investigation loops.
 * Linkage is by LABEL in the destination system (`parent`, `finding`, idempotency `key`),
 * so any loop — or a human — can find the obligations a loop created.
 */
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'terminated' | 'unknown';

export interface RootCause {
  summary: string;
  fix: { summary: string; ref: string };
  /** Something else must be fixed first → a sub-investigation (recursion). */
  requires?: { title: string; signature: string };
}

export interface BugView {
  id: string;
  key: string;
  title: string;
  /** `exp:checkout_v2` or `bug:B-1` — who is waiting on this bug. */
  parent: string;
  /** The parent's finding this bug is handling. */
  finding: string;
  signature: string;
  depth: number;
  status: 'open' | 'fixed' | 'wontfix';
  createdAt: number;
  closedAt?: number;
  rootCause?: RootCause;
  /** Set while the bug is handed to a person (the investigation escalated `finding`); cleared when they hand it back. */
  withPerson?: { finding: string; since: number };
  notes: string[];
}

export interface FixView {
  clId: string;
  key: string;
  parent: string;
  finding: string;
  /** What the fix patches (the root cause's `fix.ref`), so a loop can tell which fix is for which cause. */
  ref: string;
  state: 'submitted' | 'in-prod';
}

/**
 * A page to a human on-call, as the pager / incident tool shows it. While open it holds
 * the loop that raised it; the human resolves it when they're done (fixed, or noise).
 */
export interface PageView {
  id: string;
  key: string;
  parent: string;
  finding: string;
  reason: string;
  status: 'open' | 'resolved';
  openedAt: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface SystemsActivities {
  listChildBugs(parent: string): Promise<BugView[]>;
  listFixes(parent: string): Promise<FixView[]>;
  /** Uses the workflow-engine client (describe) from an activity. */
  workflowStatus(workflowId: string): Promise<WorkflowStatus>;
  fileBug(req: { key: string; parent: string; finding: string; title: string; signature: string; depth: number }): Promise<string>;
  submitFix(req: { key: string; parent: string; finding: string; patch: { summary: string; ref: string } }): Promise<string>;
}

export const investigationId = (bugId: string) => `investigate:${bugId}`;
