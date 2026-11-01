/** Fakes for the local review loop and the human code-review loop. */
import { HOUR, MIN, type Sim } from '../runtime/sim.js';
import type { ReviewActivities, ReviewComment } from '../scenarios/review-loop.js';
import { BOT, type Category, type CLView, type CodeReviewActivities, type Thread } from '../scenarios/code-review.js';

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

// ───────────────────────────── human code review ─────────────────────────────

const PREFIX: Record<string, Category> = { nit: 'nit', bug: 'bug', q: 'question', design: 'design', praise: 'praise' };

export class FakeCodeReview {
  readonly cl: CLView;
  readonly calls: Record<string, number> = {};
  private keys = new Set<string>();
  private seq = 0;
  ownerApprovalDelay = 3 * HOUR;
  ownerDecisionDelay = 5 * HOUR;
  /** Drafts are accepted but never show up on the CL (a lost handoff). */
  loseDrafts = false;

  constructor(private sim: Sim, private watcher: string, owner = 'olivia') {
    this.cl = { id: 'cl/100', owner, revision: 1, submitted: false, approvals: [], threads: [] };
  }

  private hint() { this.sim.signal(this.watcher, 'cl-updated'); }
  private msg(author: string, body: string, draft?: boolean) { return { id: `m${++this.seq}`, author, body, draft }; }

  /** Reviewer posts a new thread, or replies on an existing one. */
  comment(author: string, body: string, threadId?: string) {
    if (threadId) {
      const t = this.cl.threads.find((t) => t.id === threadId)!;
      t.messages.push(this.msg(author, body));
      t.resolved = false;
    } else {
      this.cl.threads.push({ id: `t${this.cl.threads.length + 1}`, resolved: false, labels: [], messages: [this.msg(author, body)] });
    }
    this.hint();
  }

  /** Reviewer pass: acknowledge answered threads; approve if nothing of theirs is outstanding. */
  reviewerPass(reviewer: string) {
    for (const t of this.cl.threads.filter((t) => !t.resolved)) {
      const last = [...t.messages].reverse().find((m) => !m.draft)!;
      if (last.author !== reviewer) t.resolved = true;
    }
    if (this.cl.threads.every((t) => t.resolved) && !this.cl.approvals.includes(reviewer)) this.cl.approvals.push(reviewer);
    this.hint();
  }

  activities(): CodeReviewActivities {
    const r = this;
    const count = (n: string) => { r.calls[n] = (r.calls[n] ?? 0) + 1; };
    const once = (key: string) => { if (r.keys.has(key)) return false; r.keys.add(key); return true; };
    const thread = (id: string) => r.cl.threads.find((t) => t.id === id)!;
    return {
      async getCL() { count('getCL'); return structuredClone(r.cl); },
      async classify(_cl, t: Thread) {
        count('classify');
        const body = [...t.messages].reverse().find((m) => !m.draft)!.body;
        const category = PREFIX[body.split(':')[0]!] ?? 'question';
        return { category, rationale: `looks like a ${category}` };
      },
      async addressInCode(_cl, threads, key) {
        count('addressInCode');
        if (!once(key)) return r.cl.revision;
        await r.sim.sleep(30 * MIN);
        r.cl.revision++;
        for (const t of threads) { const live = thread(t.id); live.messages.push(r.msg(BOT, `Done in r${r.cl.revision}`)); live.resolved = true; }
        return r.cl.revision;
      },
      async composeReply(_cl, t) { count('composeReply'); return `Re: ${t.messages[t.messages.length - 1]!.body}`; },
      async postReply(_cl, threadId, body, { draft, key }) {
        count('postReply');
        if (!once(key) || (draft && r.loseDrafts)) return;
        const m = r.msg(BOT, body, draft);
        thread(threadId).messages.push(m);
        if (draft) r.sim.timer(r.ownerApprovalDelay, () => { m.draft = false; r.hint(); }); // owner publishes the draft
      },
      async escalateToOwner(_cl, threadId, _reason, key) {
        count('escalateToOwner');
        if (!once(key)) return;
        thread(threadId).labels.push('needs-owner');
        r.sim.timer(r.ownerDecisionDelay, () => { thread(threadId).messages.push(r.msg(r.cl.owner, 'Agreed — follow-up CL, tracked in B-77.')); r.hint(); });
      },
      async submit(_cl, key) { count('submit'); if (once(key)) r.cl.submitted = true; },
    };
  }
}
