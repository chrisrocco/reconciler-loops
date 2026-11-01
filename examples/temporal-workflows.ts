/**
 * Real Temporal wiring (typechecks against @temporalio/workflow; not run in tests).
 * Activities are implemented in the worker against your real bug tracker, deploy
 * system, metrics store, and Temporal client (for `workflowStatus` → describe()).
 */
import { continueAsNew, proxyActivities } from '@temporalio/workflow';
import { reconcile } from '../src/core/reconcile.js';
import type { LoopMemory } from '../src/core/types.js';
import { logTick, temporalRuntime } from '../src/runtime/temporal.js';
import { experimentSpec, type ExperimentActivities, type ExperimentInput } from '../src/scenarios/experiment.js';
import { investigationSpec, type InvestigationActivities, type InvestigationInput } from '../src/scenarios/investigation.js';
import { reviewLoopSpec, type ReviewActivities } from '../src/scenarios/review-loop.js';

const expActs = proxyActivities<ExperimentActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});
const invActs = proxyActivities<InvestigationActivities>({
  startToCloseTimeout: '2 days',     // agentic RCA is long-running …
  heartbeatTimeout: '5 minutes',     // … so it heartbeats
});
const reviewActs = proxyActivities<ReviewActivities>({ startToCloseTimeout: '30 minutes' });

/**
 * Workflow id convention: `experiment:<flag>` (experimentWorkflowId) — stable, so a restart reuses it and child
 * hints still land. Questions (use this experiment? create with these fields?) wait for a person's answer by
 * signal; set a kind in autoApprove to let the agent take its own suggestion instead.
 */
export async function experiment(input: ExperimentInput & { memory?: LoopMemory; answers?: Record<string, unknown> }) {
  const rt = temporalRuntime({ autoApprove: [] }, input.answers);
  const out = await reconcile(rt, experimentSpec(rt, expActs, input, rt.decisions), { memory: input.memory, maxTicksPerRun: 300, onTick: logTick });
  if (out.status === 'checkpoint') return continueAsNew<typeof experiment>({ ...input, memory: out.memory, answers: rt.decisions.snapshot() });
  if (out.status !== 'done') {
    const expId = out.memory.facts.experimentId as string | undefined;
    if (expId) await expActs.setStage(expId, 0, `exp:${input.flagName}/safe-hold`);
    await expActs.escalate(input.flagName, out.reason);
  }
  return out.status;
}

/** Registered under the type name 'investigation' (what the specs pass to startChild). */
export async function investigation(input: InvestigationInput & { memory?: LoopMemory }) {
  const rt = temporalRuntime();
  const out = await reconcile(rt, investigationSpec(rt, invActs, input), { memory: input.memory, maxTicksPerRun: 300, onTick: logTick });
  if (out.status === 'checkpoint') return continueAsNew<typeof investigation>({ ...input, memory: out.memory });
  if (out.status !== 'done') await invActs.annotateBug(input.bugId, `investigation ${out.status}: ${out.reason} — needs a human`);
  return out.status;
}

/** The review loop is a sub-routine: called inline in the middle of a larger authoring workflow. */
export async function authorChange(input: { changeId: string }) {
  const rt = temporalRuntime();
  // … plan + write the change via activities …
  const review = await reconcile(rt, reviewLoopSpec(reviewActs, { changeId: input.changeId, dimensions: ['correctness', 'tests', 'style', 'security'] }), { onTick: logTick });
  if (review.status !== 'done') return { mailed: false, why: review.status };
  // … mail for human review, then hand off to the code-review loop …
  return { mailed: true };
}
