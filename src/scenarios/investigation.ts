/**
 * Recursive bug investigation — the child loop. Same framework, same shape:
 *   findings  = what the investigation still lacks (root cause, sub-fix, fix), or a live
 *               fix that verification says didn't cure the symptom
 *   blockers  = its own open sub-bugs, undeployed fix CLs, and the bug itself while a person has it
 *   progress  = close only once the fix is live AND verification says the symptom is gone
 *   escalation= a finding out of attempts hands the bug to a person; the loop holds until they
 *               close it or hand it back
 *   done      = the bug is closed (by this loop OR by a human)
 * It never knows who its parent is beyond a workflow id to hint.
 */
import type { EscalateAction, Finding, ReconcilerSpec } from '../core/types.js';
import type { Runtime } from '../core/runtime.js';
import { reconcileToEnd, type RunOptions } from '../core/reconcile.js';
import { HOUR } from '../core/time.js';
import { investigationId, type BugView, type FixView, type SystemsActivities, type WorkflowStatus } from './systems.js';

export interface InvestigationActivities extends SystemsActivities {
  getBug(bugId: string): Promise<BugView>;
  /** Agentic RCA; long-running (heartbeating) activity. Writes the root cause onto the bug. */
  analyze(bugId: string, attempt: number): Promise<void>;
  /**
   * Re-check the bug's symptom in prod now that its fix is live (a repro, or the signal
   * the bug was filed for). `pending` until there is enough post-rollout data to tell.
   */
  verifyFix(bugId: string): Promise<Verification>;
  closeBug(bugId: string, resolution: 'fixed' | 'wontfix', note: string): Promise<void>;
  annotateBug(bugId: string, note: string): Promise<void>;
  /** Hand the bug to a person about one finding: how this loop escalates. Idempotent on `key`. */
  escalateBug(req: { bugId: string; key: string; finding: string; reason: string }): Promise<void>;
}

export interface InvestigationInput {
  bugId: string;
  parentWorkflowId: string;
  depth: number;
  maxDepth: number;
}

export interface Verification { verdict: 'cured' | 'reproduces' | 'pending'; detail: string }

interface InvWorld { bug: BugView; subBugs: BugView[]; fixes: FixView[]; subInv: Record<string, WorkflowStatus>; verification?: Verification }
type InvFinding = Finding<'needs-rca' | 'needs-sub' | 'needs-fix' | 'fix-ineffective', { signature?: string; title?: string }>;
type InvAction =
  | { key: string; kind: 'analyze'; targets: string[] }
  | { key: string; kind: 'file-sub-bug'; targets: string[]; title: string; signature: string; deadlineMs: number }
  | { key: string; kind: 'start-investigation'; bugId: string }
  | { key: string; kind: 'submit-fix'; targets: string[]; deadlineMs: number }
  | { key: string; kind: 'close' }
  | EscalateAction;

export function investigationSpec(
  rt: Runtime, acts: InvestigationActivities, input: InvestigationInput,
): ReconcilerSpec<InvWorld, InvFinding, InvAction> {
  const self = `bug:${input.bugId}`;
  return {
    name: `investigate:${input.bugId}`,
    budget: { maxDurationMs: 45 * 24 * HOUR, maxAttemptsPerFinding: 3, escalationDeadlineMs: HOUR },

    async observe() {
      const [bug, subBugs, fixes] = await Promise.all([
        acts.getBug(input.bugId), acts.listChildBugs(self), acts.listFixes(self),
      ]);
      const open = subBugs.filter((b) => b.status === 'open');
      const subInv = Object.fromEntries(
        await Promise.all(open.map(async (b) => [b.id, await acts.workflowStatus(investigationId(b.id))] as const)),
      );
      const rc = bug.rootCause;
      const sub = rc?.requires && subBugs.find((b) => b.signature === rc.requires!.signature);
      // The fix for the CURRENT root cause; an earlier fix for a cause that turned out wrong doesn't count.
      const fix = rc && fixes.find((x) => x.ref === rc.fix.ref);
      const findings: InvFinding[] = [];
      if (!rc) findings.push({ id: 'rca', kind: 'needs-rca', severity: 'blocking', summary: 'root cause unknown', data: {} });
      else if (rc.requires && !sub)
        findings.push({ id: `sub:${rc.requires.signature}`, kind: 'needs-sub', severity: 'blocking', summary: rc.requires.title, data: rc.requires });
      else if ((!rc.requires || sub?.status === 'fixed') && !fix)
        findings.push({ id: 'fix', kind: 'needs-fix', severity: 'blocking', summary: rc.fix.summary, data: {} });

      // Deployed is not cured: once nothing else is outstanding, check the symptom is really gone.
      let verification: Verification | undefined;
      if (fix?.state === 'in-prod' && !findings.length && !open.length && fixes.every((x) => x.state === 'in-prod')) {
        verification = await acts.verifyFix(input.bugId);
        if (verification.verdict === 'reproduces')
          findings.push({ id: 'verify', kind: 'fix-ineffective', severity: 'blocking', summary: verification.detail, data: {} });
      }

      return {
        world: { bug, subBugs, fixes, subInv, verification },
        findings,
        blockers: [
          ...open.map((b) => ({ id: `bug:${b.id}`, kind: 'child-bug', on: [b.finding], scope: 'loop' as const, summary: b.title, since: b.createdAt })),
          ...fixes.filter((x) => x.state !== 'in-prod').map((x) => ({ id: `deploy:${x.clId}`, kind: 'deploy', on: [x.finding], scope: 'loop' as const, summary: `${x.clId} rolling out` })),
          ...(bug.withPerson ? [{ id: `person:${bug.id}`, kind: 'person', on: [bug.withPerson.finding], scope: 'loop' as const, summary: 'handed to a person', since: bug.withPerson.since }] : []),
        ],
      };
    },

    done: (f) => (f.world.bug.status !== 'open' ? `bug ${f.world.bug.status}` : undefined),

    plan(f) {
      const { bug, subBugs, subInv, verification } = f.world;
      const actions: InvAction[] = [];
      // Repair: an open sub-bug with nobody investigating it (never started, or lost).
      for (const b of subBugs.filter((b) => b.status === 'open'))
        if (subInv[b.id] === 'unknown' || subInv[b.id] === 'terminated')
          actions.push({ key: `start:${b.id}@${f.tick}`, kind: 'start-investigation', bugId: b.id });

      if (subBugs.some((b) => b.status === 'wontfix' && b.signature === bug.rootCause?.requires?.signature))
        return { actions: [], wake: { afterMs: HOUR }, halt: { status: 'escalated', reason: 'required dependency was closed wontfix' } };

      for (const x of f.open) {
        const ep = (f.attempts[x.id] ?? 0) + 1;
        if (x.kind === 'needs-rca') actions.push({ key: `rca:${ep}`, kind: 'analyze', targets: [x.id] });
        // The live fix didn't cure it, so the root cause was wrong or incomplete: analyze again.
        if (x.kind === 'fix-ineffective') actions.push({ key: `reanalyze:${ep}`, kind: 'analyze', targets: [x.id] });
        if (x.kind === 'needs-fix') actions.push({ key: `fix:${ep}`, kind: 'submit-fix', targets: [x.id], deadlineMs: HOUR });
        if (x.kind === 'needs-sub') {
          if (input.depth + 1 > input.maxDepth)
            return { actions: [], wake: { afterMs: HOUR }, halt: { status: 'escalated', reason: `needs sub-investigation beyond maxDepth=${input.maxDepth}` } };
          actions.push({ key: `sub:${x.data.signature}:${ep}`, kind: 'file-sub-bug', targets: [x.id], title: x.data.title!, signature: x.data.signature!, deadlineMs: HOUR });
        }
      }

      // Progress: fix is live, verified, and nothing outstanding ⇒ close.
      if (!f.findings.length && !f.held && verification?.verdict === 'cured') actions.push({ key: 'close', kind: 'close' });
      return {
        actions, wake: { afterMs: f.held ? 4 * HOUR : verification?.verdict === 'pending' ? 2 * HOUR : HOUR, signals: ['child-closed'] },
        note: verification && verification.verdict !== 'reproduces' ? `verification ${verification.verdict}: ${verification.detail}` : undefined,
      };
    },

    async act(a, f) {
      switch (a.kind) {
        case 'analyze': await acts.analyze(input.bugId, (f.attempts['rca'] ?? 0) + (f.attempts['verify'] ?? 0)); break;
        case 'file-sub-bug':
          await acts.fileBug({ key: `${self}/${a.key}`, parent: self, finding: a.targets[0]!, title: a.title, signature: a.signature, depth: input.depth + 1 });
          break;
        case 'start-investigation':
          await rt.startChild({
            workflowId: investigationId(a.bugId), workflow: 'investigation',
            input: { bugId: a.bugId, parentWorkflowId: rt.workflowId, depth: input.depth + 1, maxDepth: input.maxDepth } satisfies InvestigationInput,
          });
          break;
        case 'submit-fix':
          await acts.submitFix({ key: `${self}/${a.key}`, parent: self, finding: 'fix', patch: f.world.bug.rootCause!.fix });
          break;
        case 'escalate':
          await acts.escalateBug({ bugId: input.bugId, key: `${self}/${a.key}`, finding: a.finding, reason: a.reason });
          break;
        case 'close':
          await acts.closeBug(input.bugId, 'fixed', `fixed by ${f.world.fixes.map((x) => x.clId).join(', ')}; verified: ${f.world.verification!.detail}`);
          await rt.hint(input.parentWorkflowId, 'child-closed');
          break;
      }
    },
  };
}

export async function investigationWorkflow(
  rt: Runtime, acts: InvestigationActivities, input: InvestigationInput, opts: RunOptions = {},
) {
  const out = await reconcileToEnd(rt, investigationSpec(rt, acts, input), { maxTicksPerRun: 200, ...opts });
  if (out.status !== 'done') {
    // Leave the bug OPEN with a note: the parent stays blocked until a human acts.
    await acts.annotateBug(input.bugId, `investigation ${out.status}: ${'reason' in out ? out.reason : ''} — needs a human`);
  }
  return { status: out.status };
}
