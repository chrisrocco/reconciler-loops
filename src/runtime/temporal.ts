/**
 * Runtime adapter for Temporal's TypeScript SDK (workflow sandbox side).
 * If your "temporal-style" framework isn't Temporal itself, this file is the
 * template: four methods map onto timers+signals, child start, and signal-external.
 *
 * Usage inside a workflow:
 *
 *   export async function experimentWorkflow(input: ExperimentInput & { memory?: LoopMemory; answers?: Record<string, unknown> }) {
 *     const rt = temporalRuntime({ autoApprove: ['mount-or-create'] }, input.answers);
 *     const acts = proxyActivities<ExperimentActivities>({ startToCloseTimeout: '10 minutes' });
 *     const out = await reconcile(rt, experimentSpec(rt, acts, input, rt.decisions), { memory: input.memory, maxTicksPerRun: 500 });
 *     if (out.status === 'checkpoint') await continueAsNew<typeof experimentWorkflow>({ ...input, memory: out.memory, answers: rt.decisions.snapshot() });
 *     return summarize(out);
 *   }
 */
import {
  condition, defineQuery, defineSignal, getExternalWorkflowHandle, log, ParentClosePolicy, setHandler,
  startChild, workflowInfo,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/common';
import type { Runtime, WakeReason } from '../core/runtime.js';
import type { TickRecord } from '../core/types.js';
import { SignalDecisions, type DecisionPolicy, type Question } from '../core/decisions.js';

/** One signal for every hint; the payload names the hint. Hints carry no state. */
export const hintSignal = defineSignal<[string]>('reconciler.hint');

/** An answer from the decision component: the question's key and the chosen option. A signal, never an Update. */
export const answerSignal = defineSignal<[key: string, answer: unknown]>('reconciler.answer');
/** The questions this workflow is waiting on, for whatever shows them to people. */
export const questionsQuery = defineQuery<Question<unknown>[]>('reconciler.questions');

/**
 * `answers` carries answers across continue-as-new (`decisions.snapshot()`), so nobody is asked twice.
 * An answer also wakes the loop, as the hint `answered`.
 */
export function temporalRuntime(policy: DecisionPolicy = {}, answers: Record<string, unknown> = {}): Runtime & { decisions: SignalDecisions } {
  const pending = new Set<string>();
  const decisions = new SignalDecisions(policy, answers);
  setHandler(hintSignal, (name) => { pending.add(name); });
  setHandler(answerSignal, (key, answer) => { decisions.answer(key, answer); pending.add('answered'); });
  setHandler(questionsQuery, () => [...decisions.asked.values()]);

  return {
    decisions,
    get workflowId() { return workflowInfo().workflowId; },

    // Date.now() is deterministic inside the Temporal workflow sandbox.
    now: () => Date.now(),

    historyLarge: () => workflowInfo().continueAsNewSuggested,

    async wait({ timeoutMs, signals }): Promise<WakeReason> {
      const match = () => [...pending].find((s) => !signals || signals.includes(s));
      const fired = await condition(() => match() !== undefined, timeoutMs);
      if (!fired) return { reason: 'timeout' };
      const name = match()!;
      pending.clear();
      return { reason: 'signal', name };
    },

    async startChild({ workflowId, workflow, input }) {
      try {
        await startChild(workflow, {
          workflowId,
          args: [input],
          // The child is an independent investigation: it must survive the parent
          // being terminated, reset, or continued-as-new.
          parentClosePolicy: ParentClosePolicy.ABANDON,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        });
        return 'started';
      } catch (e) {
        if (e instanceof WorkflowExecutionAlreadyStartedError) return 'exists';
        throw e;
      }
    },

    async hint(workflowId, signal) {
      // Best effort: the target may have finished or not exist yet.
      await getExternalWorkflowHandle(workflowId).signal(hintSignal, signal).catch(() => undefined);
    },
  };
}

// #region log-tick
/** Pass as `onTick`: one `tick` line per tick through the workflow logger. A plan repeating itself is a bug in its keys, so it is also logged as an error for the loop's owner. */
export function logTick(rec: TickRecord) {
  if (rec.stalled.length) log.error('plan re-proposes actions already taken', { loop: rec.loop, findings: rec.stalled });
  log.info('tick', { ...rec });
}
// #endregion
