/** Fake for the local review loop. The code-review loop's fake is review-system.ts. */
import { MIN, type Sim } from '../runtime/sim.js';
import type { ReviewActivities, ReviewComment } from '../scenarios/review-loop.js';

// ───────────────────────────── local review ─────────────────────────────

export interface PlantedIssue extends ReviewComment {
  /** Revise calls targeting it before it's actually fixed. Infinity = stubborn. */
  fixAfter: number;
  /** Fixing it introduces this regression in the next revision. */
  introducesOnFix?: Omit<PlantedIssue, 'from'>;
}

export class FakeChange {
  revision = 0;
  readonly calls = { review: 0, revise: 0 };
  private issues: (PlantedIssue & { from: number; attempts: number; fixedAt?: number })[] = [];
  constructor(private sim: Sim, planted: PlantedIssue[]) { planted.forEach((p) => this.issues.push({ ...p, from: 0, attempts: 0 })); }

  activities(): ReviewActivities {
    const c = this;
    const live = (rev: number) => c.issues.filter((i) => i.from <= rev && (i.fixedAt === undefined || i.fixedAt > rev));
    return {
      async currentRevision() { return c.revision; },
      async review(dimension, _id, rev) {
        c.calls.review++;
        await c.sim.sleep(5 * MIN);
        return live(rev).filter((i) => i.dimension === dimension)
          .map(({ dimension, location, issue, severity, detail }) => ({ dimension, location, issue, severity, detail }));
      },
      async revise(_id, from, comments) {
        c.calls.revise++;
        await c.sim.sleep(20 * MIN);
        if (c.revision !== from) return c.revision; // idempotent: already revised from `from`
        c.revision = from + 1;
        for (const cm of comments) {
          const i = live(from).find((i) => i.dimension === cm.dimension && i.location === cm.location && i.issue === cm.issue);
          if (!i) continue;
          i.attempts++;
          if (i.attempts >= i.fixAfter) {
            i.fixedAt = c.revision;
            if (i.introducesOnFix) c.issues.push({ ...i.introducesOnFix, from: c.revision, attempts: 0 });
          }
        }
        return c.revision;
      },
    };
  }
}
