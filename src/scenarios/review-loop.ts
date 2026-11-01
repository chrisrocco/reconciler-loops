/**
 * Scenario 1 — local review loop (minutes).
 * N dimension reviewers look at the current revision; their comments are findings;
 * the author agent addresses all open findings in one revision; repeat until clean.
 * The loop runs inline for minutes with nobody to page, so a finding it can't resolve
 * (escalated) or running out of rounds stops it, and the caller hands the change to a person.
 */
import type { Finding, ReconcilerSpec } from '../core/types.js';

export interface ReviewComment {
  dimension: string;
  location: string;
  issue: string;
  severity: 'blocking' | 'advisory';
  detail: string;
}

export interface ReviewActivities {
  currentRevision(changeId: string): Promise<number>;
  review(dimension: string, changeId: string, revision: number): Promise<ReviewComment[]>;
  revise(changeId: string, fromRevision: number, comments: ReviewComment[]): Promise<number>;
}

export type ReviewFinding = Finding<'review-comment', ReviewComment>;
export type ReviewAction = { key: string; kind: 'revise'; targets: string[]; comments: ReviewComment[] };

export interface ReviewInput {
  changeId: string;
  dimensions: string[];
  maxRounds?: number;
  maxAttemptsPerFinding?: number;
}

// #region inline-review
export function reviewLoopSpec(
  acts: ReviewActivities,
  input: ReviewInput,
): ReconcilerSpec<{ revision: number }, ReviewFinding, ReviewAction> {
  const { changeId, dimensions } = input;
  return {
    name: `review:${changeId}`,
    budget: { maxAttemptsPerFinding: input.maxAttemptsPerFinding ?? 3 },

    async observe({ memo }) {
      const revision = await acts.currentRevision(changeId);
      // Reviews are memoized per (dimension, revision): resuming never re-pays for a review.
      const batches = await Promise.all(
        dimensions.map((d) => memo.get(`review:${d}@r${revision}`, () => acts.review(d, changeId, revision))),
      );
      const findings = batches.flat().map<ReviewFinding>((c) => ({
        // Fingerprint ignores revision: an unfixed comment is the SAME finding next round.
        id: `${c.dimension}:${c.location}:${c.issue}`,
        kind: 'review-comment', severity: c.severity, summary: c.detail, data: c,
      }));
      return { world: { revision }, findings, blockers: [] };
    },

    done: (f) => (f.findings.some((x) => x.severity === 'blocking') ? undefined : `clean at r${f.world.revision}`),

    plan(f) {
      const stuck = f.escalating[0];
      if (stuck) return { actions: [], wake: { afterMs: 0 }, halt: { status: 'escalated', reason: `${stuck.finding.id}: ${stuck.reason}` } };
      const maxRounds = input.maxRounds ?? 6;
      if (f.tick >= maxRounds) return { actions: [], wake: { afterMs: 0 }, halt: { status: 'escalated', reason: `not clean after ${maxRounds} rounds` } };
      if (!f.open.length) return { actions: [], wake: { afterMs: 60_000 } };
      return {
        actions: [{
          key: `revise:r${f.world.revision}`, kind: 'revise',
          targets: f.open.map((x) => x.id), comments: f.open.map((x) => x.data),
        }],
        wake: { afterMs: 0 },
        note: `addressing ${f.open.length} finding(s) on r${f.world.revision}`,
      };
    },

    async act(a, f) {
      // An escalation needs no effect here: the loop stops, and the caller hands the change over.
      if (a.kind === 'revise') await acts.revise(changeId, f.world.revision, a.comments);
    },
  };
}
// #endregion
