import type { ComponentType } from 'react';
import type { SimulationId } from '../content/schema';
import { ExperimentSim } from './experiment/ExperimentSim';
import { CodeReviewSim } from './code-review/CodeReviewSim';
import { ReviewLoopSim } from './review-loop/ReviewLoopSim';
import { MigrationSim } from './migration/MigrationSim';
import { OnCallSim } from './on-call/OnCallSim';

export interface SimInfo {
  id: SimulationId;
  title: string;
  runsFor: string;
  blurb: string;
  /** What to watch for, one line each. */
  watch: string[];
  Component: ComponentType<{ variant?: string }>;
}

export const SIMS: SimInfo[] = [
  {
    id: 'experiment', title: 'Experiment ramp', runsFor: 'weeks', Component: ExperimentSim,
    blurb: 'Ramp a feature through traffic stages while guardrails watch for harm. Regressions spawn child investigations, and the ramp waits on them.',
    watch: ['Ramp policies, a four-week holdback, and three arms ramping side by side', 'A realistic world with noisy metrics, flaky systems and wrong agents', 'Child loops, crash recovery, escalation, safe holds'],
  },
  {
    id: 'code-review', title: 'Code review', runsFor: 'days', Component: CodeReviewSim,
    blurb: 'Drive a change to submitted: answer reviewers, add the owners and approvers it needs, keep checks green and the branch mergeable, and submit once every requirement is met.',
    watch: ['Unmet submit requirements as findings', 'A reviewer who never responds, aged out and swapped', 'Approvals that reset on a new patchset'],
  },
  {
    id: 'review-loop', title: 'Inline review loop', runsFor: 'minutes', Component: ReviewLoopSim,
    blurb: 'A loop inside a bigger workflow: reviewers comment, the author agent revises, until the change is clean or the loop gives up.',
    watch: ['A fix that introduces a new finding', 'A stubborn finding that stops an inline loop', 'A round limit as "the plan says stop"'],
  },
  {
    id: 'migration', title: 'Large-scale migration', runsFor: 'months', Component: MigrationSim,
    blurb: 'Move a codebase to a new framework, one child loop per component, with work-in-progress limits and prerequisites.',
    watch: ['Components waiting on their dependencies', 'A change that conflicts and is converted again', 'A component its team migrates by hand'],
  },
  {
    id: 'on-call', title: 'On-call agent', runsFor: 'forever', Component: OnCallSim,
    blurb: 'Keep builds green and releases moving: revert, quarantine, pause, and file an issue for each owner. No goal, no time budget.',
    watch: ['Reverting the next suspect when the first was innocent', 'Ignored issues escalated to the lead', 'Bounded memory over a quarter'],
  },
];
