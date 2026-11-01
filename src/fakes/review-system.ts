/**
 * Fake review system for the code-review loop, shaped like a large company's internal one:
 * per-directory owners, per-language approvals and a review approval (all computed by the system,
 * as submit requirements), an attention set, scripted reviewers, analyzer comments, required
 * checks that fail for real or flakily, a target branch that moves, and votes that are either
 * sticky or reset by a new patchset.
 */
import { HOUR, MIN, type Sim } from '../runtime/sim.js';
import {
  AGENT, type Category, type ChangeView, type Check, type CodeReviewActivities, type Message, type Requirement, type Thread,
} from '../scenarios/code-review.js';

/** A comment a reviewer posts. Its prefix tells the fake judge what kind it is. */
export interface ScriptedComment {
  /** `nit:`, `bug:`, `suggest:` (worth taking), `alt:` (the agent would push back), `q:`, `design:`, `praise:`. */
  body: string;
  location?: string;
}

export interface Person {
  user: string;
  /** Directories they own (`search/`). */
  owns?: string[];
  /** Languages they can approve. */
  languages?: string[];
  away?: boolean;
  /** Takes a turn, but never comes back to the change. */
  unresponsive?: boolean;
  /** How long they take once it's their turn. */
  turnaround?: number;
  /** What they say on each pass. Once it runs out, they approve when nothing they raised is open. */
  passes?: ScriptedComment[][];
}

export interface CheckSpec {
  name: string;
  required?: boolean;
  durationMs?: number;
  /** The first N runs fail flakily (the check system flags them as likely flaky). */
  flakyRuns?: number;
  /** Fails for real until the agent has fixed it this many times. */
  fixesNeeded?: number;
}

export interface ReviewSystemConfig {
  change?: string;
  owner?: string;
  files: { path: string; language: string }[];
  people: Person[];
  /** Reviewers on the change from the start. */
  reviewers?: string[];
  /** Analyzer findings posted on the first patchset: `lint:` (valid) or `lint-fp:` (doesn't apply). */
  analyzer?: ScriptedComment[];
  checks?: CheckSpec[];
  /** `sticky`: an approval survives new patchsets. `reset`: a new patchset (other than a clean rebase) clears approvals. */
  votes?: 'sticky' | 'reset';
  /** The target branch moves at these times; `conflicts` means a plain rebase won't apply. */
  headMoves?: { at: number; conflicts?: boolean }[];
  /** How long the owner takes to publish a draft or answer a question. */
  ownerDelayMs?: number;
  /** Drafts are accepted but never show up (a lost handoff). */
  loseDrafts?: boolean;
}

interface Run { name: string; patchset: number; startedAt: number; runs: number; state: Check['state']; likelyFlaky: boolean }

export class ReviewSystem {
  readonly id: string;
  readonly owner: string;
  status: ChangeView['status'] = 'open';
  patchset = 1;
  readonly threads: Thread[] = [];
  readonly reviewers = new Map<string, { addedAt: number; turnSince?: number; pass: number }>();
  readonly votes = new Map<string, number>(); // user → patchset approved
  readonly calls: Record<string, number> = {};
  readonly events: { at: number; who: string; what: string }[] = [];
  private checks = new Map<string, Run>();
  private fixes = new Map<string, number>();
  private flakesLeft = new Map<string, number>();
  private head = 'h0';
  private rebasedOnto = 'h0';
  private conflictHead?: string;
  private ownerTagged = false;
  private keys = new Set<string>();
  private seq = 0;
  private cfg: Required<Pick<ReviewSystemConfig, 'votes' | 'ownerDelayMs'>> & ReviewSystemConfig;

  constructor(private sim: Sim, private watcher: string, cfg: ReviewSystemConfig) {
    this.cfg = { votes: 'sticky', ownerDelayMs: 3 * HOUR, ...cfg };
    this.id = cfg.change ?? 'change/100';
    this.owner = cfg.owner ?? 'olivia';
    for (const c of cfg.checks ?? []) this.flakesLeft.set(c.name, c.flakyRuns ?? 0);
    for (const u of cfg.reviewers ?? []) this.add(u);
    for (const f of cfg.analyzer ?? []) this.newThread('analyzer', f, 'analyzer');
    for (const h of cfg.headMoves ?? []) sim.at(h.at, () => this.moveHead(h.conflicts ?? false));
    this.startChecks();
  }

  // ───────────── people ─────────────

  private person(user: string) { return this.cfg.people.find((p) => p.user === user)!; }
  private log(who: string, what: string) { this.events.push({ at: this.sim.now, who, what }); this.sim.log('review', `${who}: ${what}`); }
  private hint() { this.sim.signal(this.watcher, 'change-updated'); }
  private msg(author: string, body: string, draft?: boolean): Message { return { id: `m${++this.seq}`, author, body, at: this.sim.now, draft }; }

  private newThread(author: string, c: ScriptedComment, origin: Thread['origin'] = 'person') {
    const t: Thread = { id: `t${this.threads.length + 1}`, location: c.location, origin, resolved: false, messages: [this.msg(author, c.body)] };
    this.threads.push(t);
    return t;
  }

  private add(user: string) {
    if (this.reviewers.has(user)) return;
    this.reviewers.set(user, { addedAt: this.sim.now, pass: 0 });
    this.log(user, 'added as a reviewer');
    this.giveTurn(user);
  }

  /** It becomes the reviewer's turn; a responsive, present reviewer comes back after their turnaround. */
  private giveTurn(user: string) {
    const r = this.reviewers.get(user);
    if (!r || r.turnSince !== undefined || this.status !== 'open') return;
    r.turnSince = this.sim.now;
    const p = this.person(user);
    if (p.away || p.unresponsive) return;
    this.sim.timer(p.turnaround ?? 6 * HOUR, () => this.reviewerPass(user));
  }

  /** A reviewer's pass: resolve what's been answered, say what the script says, approve when nothing of theirs is open. */
  private reviewerPass(user: string) {
    const r = this.reviewers.get(user);
    if (!r || r.turnSince === undefined || this.status !== 'open') return;
    r.turnSince = undefined;
    for (const t of this.threads.filter((t) => !t.resolved && t.messages[0]!.author === user)) {
      const last = published(t).at(-1)!;
      // The agent or the owner answered it. A question the agent put to the owner is left for the owner.
      if (last.author !== user && !(last.author === AGENT && last.body.includes(`@${this.owner}`))) t.resolved = true;
    }
    const script = this.person(user).passes ?? [];
    const now = script[r.pass] ?? [];
    r.pass++;
    for (const c of now) this.newThread(user, c);
    const mine = this.threads.filter((t) => t.messages[0]!.author === user);
    if (r.pass >= script.length && mine.every((t) => t.resolved) && this.votes.get(user) !== this.patchset) {
      this.votes.set(user, this.patchset);
      this.log(user, `approved patchset ${this.patchset}${now.length ? ' with comments' : ''}`);
    } else this.log(user, now.length ? `left ${now.length} comment(s)` : 'looked; waiting on the author');
    this.hint();
  }

  /** The owner answers whatever they were tagged on, and publishes drafts, after a delay. */
  private ownerResponds() {
    this.sim.timer(this.cfg.ownerDelayMs, () => {
      if (this.status !== 'open') return;
      for (const t of this.threads) {
        for (const m of t.messages) if (m.draft && m.author === AGENT && !this.cfg.loseDrafts) { m.draft = false; this.log(this.owner, `published the agent's draft on ${t.id}`); this.afterAgentSpoke(t); }
        const tag = [...t.messages].reverse().find((m) => !m.draft && m.author === AGENT && m.body.includes(`@${this.owner}`));
        if (!tag || t.messages.some((m) => m.author === this.owner && m.at > tag.at)) continue;
        const about = tag.body.match(/\(re ([^)]+)\)\s*$/)?.[1] ?? '';
        t.messages.push(this.msg(this.owner, this.ownerAnswer(about)));
        this.afterAgentSpoke(t);
      }
      this.ownerTagged = false;
      this.hint();
    });
  }

  /** What the owner does when asked: decide, find a reviewer, or fix it themselves. */
  private ownerAnswer(finding: string): string {
    const req = this.requirements().find((r) => r.id === finding);
    if (req) {
      // Swap out anyone on the change who can grant it but isn't responding, and add someone who will.
      for (const [u] of this.reviewers) if (req.eligible.includes(u) && (this.person(u).unresponsive || this.person(u).away)) { this.reviewers.delete(u); this.log(this.owner, `removed ${u}`); }
      const next = req.eligible.find((u) => u !== this.owner && !this.reviewers.has(u) && !this.person(u).away && !this.person(u).unresponsive);
      if (next) { this.add(next); return `Added @${next} for ${finding}.`; }
      return `No one else can grant ${finding}; I'll chase it.`;
    }
    if (finding.startsWith('check:')) { const name = finding.slice(6); this.fixes.set(name, 99); this.newPatchset(this.owner, 'fix'); return `Fixed ${name} myself.`; }
    if (finding === 'conflict') { this.rebasedOnto = this.head; this.conflictHead = undefined; this.newPatchset(this.owner, 'rebase'); return 'Resolved the conflict.'; }
    return 'Decision: keep it in this change. Reviewer, does that work for you?';
  }

  /** The agent (or the owner) has spoken on a thread: it's the thread's reviewer's turn again. */
  private afterAgentSpoke(t: Thread) {
    const author = t.messages[0]!.author;
    if (t.origin === 'analyzer') return;
    this.giveTurn(author);
  }

  // ───────────── patchsets, checks, the target branch ─────────────

  private newPatchset(by: string, why: 'fix' | 'rebase') {
    this.patchset++;
    if (this.cfg.votes === 'reset' && why !== 'rebase') this.votes.clear();
    this.log(by, `uploaded patchset ${this.patchset} (${why})`);
    this.startChecks();
    for (const [u, r] of this.reviewers) if (this.votes.get(u) === undefined && r.turnSince === undefined) this.giveTurn(u);
  }

  private startChecks() {
    for (const c of this.cfg.checks ?? []) this.runCheck(c.name, 1);
  }

  private runCheck(name: string, runs: number) {
    const spec = this.cfg.checks!.find((c) => c.name === name)!;
    const run: Run = { name, patchset: this.patchset, startedAt: this.sim.now, runs, state: 'running', likelyFlaky: false };
    this.checks.set(name, run);
    this.sim.timer(spec.durationMs ?? 40 * MIN, () => {
      if (this.checks.get(name) !== run) return; // superseded by a newer run
      const flaky = (this.flakesLeft.get(name) ?? 0) > 0;
      const broken = (this.fixes.get(name) ?? 0) < (spec.fixesNeeded ?? 0);
      if (flaky) this.flakesLeft.set(name, this.flakesLeft.get(name)! - 1);
      run.state = flaky || broken ? 'failed' : 'passed';
      run.likelyFlaky = flaky && !broken;
      this.log('checks', `${name} ${run.state}${run.likelyFlaky ? ' (likely flaky)' : ''} on patchset ${run.patchset}`);
      this.hint();
    });
  }

  private moveHead(conflicts: boolean) {
    this.head = `h${Number(this.head.slice(1)) + 1}`;
    if (conflicts) this.conflictHead = this.head;
    this.log('repo', `target branch moved to ${this.head}${conflicts ? ' (conflicts with this change)' : ''}`);
    this.hint();
  }

  // ───────────── what the system computes ─────────────

  private approvedBy(users: string[]) {
    return users.some((u) => this.votes.has(u) && (this.cfg.votes === 'sticky' || this.votes.get(u) === this.patchset));
  }

  /** Submit requirements: a review approval, an owner of each directory, approval for each language. The owner's own ownership counts. */
  requirements(): Requirement[] {
    const others = this.cfg.people.filter((p) => p.user !== this.owner);
    const me = this.cfg.people.find((p) => p.user === this.owner);
    const dirs = [...new Set(this.cfg.files.map((f) => f.path.slice(0, f.path.indexOf('/') + 1)))];
    const langs = [...new Set(this.cfg.files.map((f) => f.language))];
    const req = (id: string, summary: string, eligible: string[], self = false): Requirement =>
      ({ id, summary, eligible, satisfied: self || this.approvedBy(eligible) });
    return [
      req('review', 'an approval from a reviewer', others.map((p) => p.user)),
      ...dirs.map((d) => req(`owners:${d}`, `an owner of ${d}`, others.filter((p) => p.owns?.includes(d)).map((p) => p.user), !!me?.owns?.includes(d))),
      ...langs.map((l) => req(`language:${l}`, `${l} approval`, others.filter((p) => p.languages?.includes(l)).map((p) => p.user), !!me?.languages?.includes(l))),
    ];
  }

  view(): ChangeView {
    const attention = [
      ...(this.ownerTagged ? [this.owner] : []),
      ...[...this.reviewers].filter(([, r]) => r.turnSince !== undefined).map(([u]) => u),
    ];
    return structuredClone({
      id: this.id, owner: this.owner, status: this.status, patchset: this.patchset,
      reviewers: [...this.reviewers].map(([user, r]) => ({ user, kind: 'person' as const, addedAt: r.addedAt, turnSince: r.turnSince, away: this.person(user).away })),
      attention,
      away: this.cfg.people.filter((p) => p.away).map((p) => p.user),
      requirements: this.requirements(),
      threads: this.threads,
      checks: [...this.checks.values()].map((k) => ({ ...k, required: this.cfg.checks!.find((c) => c.name === k.name)!.required ?? true })),
      mergeable: this.conflictHead && this.rebasedOnto !== this.conflictHead ? { ok: false as const, targetHead: this.head, autoRebase: false }
        : this.rebasedOnto !== this.head ? { ok: false as const, targetHead: this.head, autoRebase: true } : { ok: true as const },
    });
  }

  // ───────────── the activities the loop calls ─────────────

  private once(key: string) { if (this.keys.has(key)) return false; this.keys.add(key); return true; }

  activities(): CodeReviewActivities {
    const s = this;
    const count = (n: string) => { s.calls[n] = (s.calls[n] ?? 0) + 1; };
    const thread = (id: string) => s.threads.find((t) => t.id === id)!;
    return {
      async getChange() { count('getChange'); return s.view(); },
      async judge(_change, t) { count('judge'); return judgeByPrefix(t); },
      async revise({ key, threads, checks, conflict }) {
        count('revise');
        if (!s.once(key)) return;
        await s.sim.sleep(45 * MIN);
        for (const name of checks) s.fixes.set(name, (s.fixes.get(name) ?? 0) + 1);
        if (conflict) { s.rebasedOnto = s.head; s.conflictHead = undefined; }
        for (const t of threads) {
          const live = thread(t.id);
          live.messages.push(s.msg(AGENT, `Done in patchset ${s.patchset + 1}.`));
          if (live.origin === 'analyzer') live.resolved = true;
        }
        s.newPatchset(AGENT, 'fix');
        for (const t of threads) s.afterAgentSpoke(thread(t.id));
        s.hint();
      },
      async reply({ key, thread: t, category, draft }) {
        count('reply');
        if (!s.once(key)) return;
        const live = thread(t.id);
        if (draft && s.cfg.loseDrafts) { s.log(AGENT, `drafted a reply on ${t.id} (lost)`); return; }
        live.messages.push(s.msg(AGENT, replyFor(category, t), draft));
        if (category === 'fyi' || category === 'not-useful') live.resolved = true; // acknowledged, or analyzer finding dismissed
        s.log(AGENT, `${draft ? 'drafted' : 'replied'} on ${t.id} (${category})`);
        if (draft) s.ownerResponds();
        else s.afterAgentSpoke(live);
        s.hint();
      },
      async addReviewer(_change, user, key) { count('addReviewer'); if (s.once(key)) { s.add(user); s.hint(); } },
      async rerunCheck(_change, name, key) {
        count('rerunCheck');
        if (!s.once(key)) return;
        const prev = s.checks.get(name)!;
        s.runCheck(name, prev.patchset === s.patchset ? prev.runs + 1 : 1);
        s.log(AGENT, `reran ${name}`);
      },
      async rebase(_change, onto, key) {
        count('rebase');
        if (!s.once(key) || s.conflictHead === onto) return;
        s.rebasedOnto = onto;
        s.newPatchset(AGENT, 'rebase');
        s.hint();
      },
      async tagOwner({ key, finding, threadId, reason }) {
        count('tagOwner');
        if (!s.once(key)) return;
        const body = `@${s.owner} ${reason} (re ${finding})`;
        if (threadId) thread(threadId).messages.push(s.msg(AGENT, body));
        else s.threads.push({ id: `t${s.threads.length + 1}`, origin: 'person', resolved: false, messages: [s.msg(AGENT, body)] });
        s.ownerTagged = true;
        s.log(AGENT, `tagged @${s.owner}: ${reason}`);
        s.ownerResponds();
        s.hint();
      },
      async submit(_change, key) {
        count('submit');
        if (!s.once(key) || s.status !== 'open') return;
        s.status = 'submitted';
        s.log(AGENT, `submitted patchset ${s.patchset}`);
      },
    };
  }
}

const published = (t: Thread) => t.messages.filter((m) => !m.draft);

/** The fake judge reads the comment's prefix. A real one is an agent call. */
export function judgeByPrefix(t: Thread): { category: Category; rationale: string } {
  const body = published(t).filter((m) => m.author !== AGENT).at(-1)?.body ?? '';
  const prefix = body.split(':')[0]!;
  const category: Category =
    prefix === 'nit' || prefix === 'bug' || prefix === 'suggest' || prefix === 'lint' ? 'fix'
      : prefix === 'q' ? 'question' : prefix === 'alt' ? 'disagree' : prefix === 'design' ? 'decision'
        : prefix === 'praise' ? 'fyi' : prefix === 'lint-fp' ? 'not-useful' : 'question';
  return { category, rationale: `reads as ${category}` };
}

function replyFor(category: Category, t: Thread): string {
  const last = published(t).filter((m) => m.author !== AGENT).at(-1)?.body ?? '';
  switch (category) {
    case 'question': return `Good question: ${last.replace(/^q:\s*/, '')} Here's why…`;
    case 'disagree': return `I'd rather keep the current approach, because…`;
    case 'fyi': return 'Thanks!';
    case 'not-useful': return 'Not useful: this pattern is intended here.';
    default: return 'Ack.';
  }
}

/** A typical change: two directories, two languages, a flaky check, analyzer findings, a reviewer who's out. */
export const TYPICAL: ReviewSystemConfig = {
  files: [
    { path: 'search/ranker.go', language: 'go' },
    { path: 'search/ranker_test.go', language: 'go' },
    { path: 'web/results.ts', language: 'typescript' },
  ],
  people: [
    { user: 'olivia', owns: ['search/'], languages: ['go'] },
    {
      user: 'alice', owns: ['search/'], languages: ['go'], turnaround: 5 * HOUR,
      passes: [[
        { body: 'nit: rename tmp to buffer', location: 'search/ranker.go:42' },
        { body: 'bug: missing nil check on user', location: 'search/ranker.go:57' },
        { body: 'q: why not reuse the existing cache?', location: 'search/ranker.go:88' },
        { body: 'design: should scoring live in its own package?' },
      ], [{ body: 'praise: nice test coverage', location: 'search/ranker_test.go:1' }]],
    },
    { user: 'bob', owns: ['web/'], languages: ['typescript'], away: true },
    { user: 'carol', owns: ['web/'], languages: ['typescript'], turnaround: 8 * HOUR, passes: [[{ body: 'alt: use a Map here instead of an object', location: 'web/results.ts:12' }]] },
  ],
  reviewers: ['alice'],
  analyzer: [{ body: 'lint-fp: possible nil dereference', location: 'web/results.ts:40' }],
  checks: [{ name: 'unit-tests', flakyRuns: 1 }, { name: 'build' }],
  headMoves: [{ at: 12 * HOUR }],
};


/** Drafts are accepted but never appear: the agent retries, then hands the thread to the owner. */
export const LOST_DRAFTS: ReviewSystemConfig = {
  files: [{ path: 'search/a.go', language: 'go' }], loseDrafts: true,
  people: [{ user: 'olivia', owns: ['search/'], languages: ['go'] }, { user: 'alice', passes: [[{ body: 'alt: use a channel here' }]] }],
  reviewers: ['alice'],
};

/** The assigned web/ owner never takes their turn: the requirement ages out and the owner swaps them. */
export const SLOW_REVIEWER: ReviewSystemConfig = {
  ...TYPICAL,
  people: [...TYPICAL.people.filter((p) => p.user !== 'bob'), { user: 'dave', owns: ['web/'], languages: ['typescript'], unresponsive: true }],
  reviewers: ['alice', 'dave'],
};

/** Votes reset on a new patchset; a conflict at head after the approval forces one. */
export const VOTES_RESET: ReviewSystemConfig = {
  files: [{ path: 'search/a.go', language: 'go' }], votes: 'reset',
  people: [{ user: 'olivia', owns: ['search/'], languages: ['go'] }, { user: 'alice', turnaround: 4 * HOUR, passes: [[{ body: 'nit: rename x' }]] }],
  reviewers: ['alice'],
  // A slow build: alice approves before it finishes, then the target branch moves with a conflict.
  checks: [{ name: 'build', durationMs: 6 * HOUR }],
  headMoves: [{ at: 10 * HOUR, conflicts: true }],
};

/** A required check fails for real, whatever the agent tries. */
export const STUCK_CHECK: ReviewSystemConfig = {
  files: [{ path: 'search/a.go', language: 'go' }],
  people: [{ user: 'olivia', owns: ['search/'], languages: ['go'] }, { user: 'alice' }],
  reviewers: ['alice'],
  checks: [{ name: 'integration', fixesNeeded: 99 }],
};
