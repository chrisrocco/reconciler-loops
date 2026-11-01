/** Experiment scenarios (mirroring test/experiment.test.ts), shared by the demo, the realistic tests and the report. */
import type { Sim } from '../runtime/sim.js';
import { DAY, HOUR } from '../core/time.js';
import type { BugView } from '../scenarios/systems.js';
import type { Defect } from './prod-world.js';

/** What scenario scripts need from a world: both ProdWorld and RealisticWorld provide it. */
export interface WorldLike {
  hooks: { onBugFiled?: (b: BugView) => void };
  humanShipsFix(defectId: string): unknown;
  humanClosesBug(bugId: string, resolution?: 'fixed' | 'wontfix'): void;
}

export interface ScenarioCtx { sim: Sim; world: WorldLike; start: () => void }

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  defects: Defect[];
  maxDepth?: number;
  maxTicksPerRun?: number;
  /** The experiment's ramp policy (RAMP_POLICIES); standard if omitted. Simulations may override it. */
  rampPolicy?: string;
  /** The experiment's time budget, when it needs longer than the default 60 days. */
  maxDurationMs?: number;
  /** Treatment arms of a multi-arm experiment. */
  arms?: string[];
  /** Install world hooks: humans acting out-of-band, crashes, restarts. */
  setup?: (ctx: ScenarioCtx) => void;
}

const EU_REVENUE = { id: 'D2', signature: 'revenue drop for EU cohort', guardrail: 'revenue_per_user', triggerStage: 2, route: 'investigate' } as const;
const STALE_FX = { id: 'D3', signature: 'stale FX rates in pricing-svc', route: 'investigate' } as const;

export const SCENARIOS: Scenario[] = [
  {
    id: 'recursion',
    title: 'Recursive investigation',
    blurb: 'A severe revenue breach triggers a rollback and a child investigation, which needs a grandchild to fix a prerequisite first.',
    defects: [{ ...EU_REVENUE, severity: 'severe', analysisHours: 20, requires: 'D3' }, { ...STALE_FX, analysisHours: 10 }],
  },
  {
    id: 'happy',
    title: 'Happy path',
    blurb: 'No defects. The loop advances one stage per soak window and concludes at 100%.',
    defects: [],
  },
  {
    id: 'quick-fix',
    title: 'Quick fix',
    blurb: 'A latency breach is triaged as a quick fix. The loop is held by the deploy until the fix CL reaches prod.',
    defects: [{ id: 'D1', signature: 'p99 regression in /checkout', guardrail: 'latency_p99', severity: 'mild', triggerStage: 1, route: 'quick-fix' }],
  },
  {
    id: 'correlated',
    title: 'Correlated metrics',
    blurb: 'One bad cache change regresses latency and CPU at once, and the error rate joins six hours later. The loop treats them as one regression: one triage, one bug, one investigation. The metric that joins mid-investigation is already covered by the open bug.',
    defects: [{ id: 'D7', signature: 'cache stampede after a config change', guardrail: 'latency_p99', alsoMoves: [{ guardrail: 'cpu_per_query' }, { guardrail: 'error_rate', afterMs: 6 * HOUR }], severity: 'mild', triggerStage: 2, route: 'investigate', analysisHours: 20 }],
  },
  {
    id: 'child',
    title: 'Child investigation',
    blurb: 'A severe breach: roll back first, file a bug, start an investigation. The open bug holds the parent until it closes.',
    defects: [{ ...EU_REVENUE, severity: 'severe', analysisHours: 30 }],
  },
  {
    id: 'crash',
    title: 'Crash and no-memory restart',
    blurb: 'The experiment workflow is terminated right after filing the bug. A fresh run with no memory sees the bug and repairs the missing investigation.',
    defects: [{ ...EU_REVENUE, severity: 'severe', analysisHours: 30 }],
    setup: ({ sim, world, start }) => {
      world.hooks.onBugFiled = () => {
        sim.terminate('experiment:checkout_v2');
        sim.timer(3 * HOUR, start);
      };
    },
  },
  {
    id: 'human',
    title: 'Human closes the bug',
    blurb: 'The RCA is slow, so a human ships a fix and closes the bug by hand. The parent unblocks by observation alone.',
    defects: [{ ...EU_REVENUE, severity: 'mild', analysisHours: 240 }],
    setup: ({ sim, world }) => {
      world.hooks.onBugFiled = (b) => {
        sim.timer(2 * DAY, () => world.humanShipsFix('D2'));
        sim.timer(2 * DAY + 9 * HOUR, () => world.humanClosesBug(b.id));
      };
    },
  },
  {
    id: 'thrash',
    title: 'Thrash guard',
    blurb: 'Every fix reaches prod but none helps. After 3 attempts the breach is escalated: the ramp rolls back to stage 0 and pages on-call. Each time on-call hands it back, the agent tries again, until the 60-day budget runs out and the ramp ends in a safe hold.',
    defects: [{ id: 'D4', signature: 'error spike in auth', guardrail: 'error_rate', severity: 'mild', triggerStage: 1, route: 'quick-fix', unfixable: true }],
  },
  {
    id: 'escalate',
    title: 'Playbook escalation',
    blurb: 'The playbook has no automated response. The loop rolls back, pages on-call and holds until they resolve the page, then finishes the ramp.',
    defects: [{ id: 'D5', signature: 'data corruption in ledger writes', guardrail: 'error_rate', severity: 'severe', triggerStage: 2, route: 'escalate' }],
  },
  {
    id: 'late-harm',
    title: 'Long-term holdback',
    blurb: 'The ramp reaches 99% and keeps a 1% holdback for four weeks. Ten days in, a revenue drop appears that no short soak would have caught. The loop files a bug, waits out the fix, and only then ends the holdback.',
    rampPolicy: 'holdback',
    maxDurationMs: 90 * DAY,
    defects: [{ id: 'D6', signature: 'repeat purchases decline after novelty wears off', guardrail: 'revenue_per_user', severity: 'mild', triggerStage: 4, onsetMs: 10 * DAY, route: 'investigate', analysisHours: 30 }],
  },
  {
    id: 'multi-arm',
    title: 'Multi-arm A/B',
    blurb: 'Three treatment arms ramp side by side. Arm B breaks revenue at 25%: only B rolls back and waits on its bug, while A and C keep ramping. The experiment concludes once every arm is at 100%.',
    arms: ['A', 'B', 'C'],
    defects: [{ ...EU_REVENUE, severity: 'severe', analysisHours: 72, arm: 'B' }],
  },
  {
    id: 'depth',
    title: 'Depth limit',
    blurb: 'With maxDepth=1 the child escalates instead of recursing. The parent stays blocked until a human fixes and closes the bug.',
    defects: [{ ...EU_REVENUE, severity: 'mild', analysisHours: 20, requires: 'D3' }, STALE_FX],
    maxDepth: 1,
    setup: ({ sim, world }) => {
      world.hooks.onBugFiled = (b) => {
        sim.timer(5 * DAY, () => world.humanShipsFix('D2'));
        sim.timer(5 * DAY + 9 * HOUR, () => world.humanClosesBug(b.id));
      };
    },
  },
];
