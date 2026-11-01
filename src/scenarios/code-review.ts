/**
 * Scenario 2 — human code review (days).
 * Unanswered human comments are findings. Each is classified against a response
 * policy (memoized), an action is proposed, and then taken: fix in code, reply
 * (auto-sent or drafted for owner approval), or escalate to the CL owner.
 * Drafts and escalations are FINDING-scoped blockers observed on the CL itself.
 * A thread the agent can't settle in three attempts is escalated to the owner the same way.
 */
import type { Blocker, Budget, EscalateAction, Finding, ReconcilerSpec } from '../core/types.js';
import { HOUR } from '../core/time.js';
import { escalation } from '../core/reconcile.js';

export const BOT = 'agent';

export interface Message { id: string; author: string; body: string; draft?: boolean }
export interface Thread { id: string; resolved: boolean; labels: string[]; messages: Message[] }
export interface CLView {
  id: string; owner: string; revision: number; submitted: boolean; approvals: string[]; threads: Thread[];
}

export type Category = 'nit' | 'bug' | 'question' | 'design' | 'praise';
export interface Classification { category: Category; rationale: string }
export type ResponsePolicy = Record<Category, { act: 'fix' } | { act: 'reply'; send: 'auto' | 'draft' } | { act: 'escalate' }>;

export const DEFAULT_POLICY: ResponsePolicy = {
  nit: { act: 'fix' },
  bug: { act: 'fix' },
  question: { act: 'reply', send: 'draft' },
  design: { act: 'escalate' },
  praise: { act: 'reply', send: 'auto' },
};

export interface CodeReviewActivities {
  getCL(clId: string): Promise<CLView>;
  classify(clId: string, thread: Thread): Promise<Classification>;
  /** Author agent: one revision addressing all threads, replying "Done" and resolving each. */
  addressInCode(clId: string, threads: Thread[], key: string): Promise<number>;
  composeReply(clId: string, thread: Thread, c: Classification): Promise<string>;
  postReply(clId: string, threadId: string, body: string, opts: { draft: boolean; key: string }): Promise<void>;
  escalateToOwner(clId: string, threadId: string, reason: string, key: string): Promise<void>;
  submit(clId: string, key: string): Promise<void>;
}

type ThreadFinding = Finding<'thread', Thread>;
type CRAction =
  | { key: string; kind: 'fix'; targets: string[]; threads: Thread[] }
  | { key: string; kind: 'reply'; targets: string[]; thread: Thread; draft: boolean; deadlineMs?: number }
  | EscalateAction
  | { key: string; kind: 'submit' };

const lastPublished = (t: Thread) => [...t.messages].reverse().find((m) => !m.draft);
const findingId = (t: Thread) => `thread:${t.id}@${lastPublished(t)?.id}`;

export function codeReviewSpec(
  acts: CodeReviewActivities,
  input: { clId: string; policy?: ResponsePolicy; pollMs?: number },
): ReconcilerSpec<CLView, ThreadFinding, CRAction, Classification> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const budget: Budget = { maxDurationMs: 21 * 24 * HOUR, maxAttemptsPerFinding: 3, escalationDeadlineMs: HOUR };
  return {
    name: `code-review:${input.clId}`,
    budget,

    async observe() {
      const cl = await acts.getCL(input.clId);
      const findings: ThreadFinding[] = [];
      const blockers: Blocker[] = [];
      for (const t of cl.threads.filter((t) => !t.resolved)) {
        const last = lastPublished(t);
        // We answer reviewers, not ourselves and not our principal (the owner).
        if (last && last.author !== BOT && last.author !== cl.owner) {
          findings.push({ id: findingId(t), kind: 'thread', severity: 'blocking', summary: last.body, data: t });
        }
        if (t.messages.some((m) => m.draft && m.author === BOT)) {
          blockers.push({ id: `draft:${t.id}`, kind: 'owner-approval', on: [findingId(t)], scope: 'finding', summary: 'draft reply awaiting owner' });
        }
        if (t.labels.includes('needs-owner') && last?.author !== cl.owner) {
          blockers.push({ id: `owner:${t.id}`, kind: 'owner-decision', on: [findingId(t)], scope: 'finding', summary: 'escalated to owner' });
        }
      }
      return { world: cl, findings, blockers };
    },

    // Classification is an LLM call: memoized per finding version, survives continue-as-new.
    async assess(open, { memo }) {
      const out: Record<string, Classification> = {};
      for (const f of open) out[f.id] = await memo.get(`classify:${f.id}`, () => acts.classify(input.clId, f.data));
      return out;
    },

    done: (f) => (f.world.submitted ? `submitted at r${f.world.revision}` : undefined),

    plan(f) {
      const actions: CRAction[] = [];
      const toFix: ThreadFinding[] = [];
      // Attempt number in every key: a lost draft or escalation (past its deadline) or a fix
      // that didn't resolve the thread is retried under a new key, up to maxAttemptsPerFinding.
      const gen = (id: string) => (f.attempts[id] ?? 0) + 1;
      for (const x of f.open) {
        const rule = policy[f.assessments[x.id]!.category];
        if (rule.act === 'fix') toFix.push(x);
        else if (rule.act === 'reply')
          actions.push({
            key: `reply:${x.id}:${gen(x.id)}`, kind: 'reply', targets: [x.id], thread: x.data, draft: rule.send === 'draft',
            deadlineMs: rule.send === 'draft' ? HOUR : undefined,
          });
        // The policy says a person decides: the same escalation the loop files when it runs out of attempts.
        else actions.push(escalation({ finding: x, reason: f.assessments[x.id]!.rationale }, f, budget));
      }
      if (toFix.length) {
        const ids = toFix.map((x) => x.id).sort();
        actions.unshift({ key: `fix:${ids.join(',')}:${Math.max(...ids.map(gen))}`, kind: 'fix', targets: ids, threads: toFix.map((x) => x.data) });
      }
      // Forward progress only on a clean frame.
      const clean = !f.findings.length && !f.blockers.length && f.world.threads.every((t) => t.resolved);
      if (clean && f.world.approvals.length && !f.world.submitted) actions.push({ key: `submit:r${f.world.revision}`, kind: 'submit' });
      return { actions, wake: { afterMs: input.pollMs ?? 2 * HOUR, signals: ['cl-updated'] } };
    },

    async act(a, f) {
      switch (a.kind) {
        case 'fix': await acts.addressInCode(input.clId, a.threads, a.key); break;
        case 'reply': {
          const body = await acts.composeReply(input.clId, a.thread, f.assessments[a.targets[0]!]!);
          await acts.postReply(input.clId, a.thread.id, body, { draft: a.draft, key: a.key });
          break;
        }
        case 'escalate': {
          const thread = f.findings.find((x) => x.id === a.finding)!.data;
          await acts.escalateToOwner(input.clId, thread.id, a.reason, a.key);
          break;
        }
        case 'submit': await acts.submit(input.clId, a.key); break;
      }
    },
  };
}
