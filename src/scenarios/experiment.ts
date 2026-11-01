/**
 * Scenario 3 — live experiment ramp (weeks), driven by a flag.
 *
 *   input         : a flag name. The loop mounts an existing experiment on the flag, or creates one
 *   desired state : experiment at final stage, soaked, every guardrail passing
 *   findings      : the flag has no experiment yet (unmounted); a regression (from metrics): ONE finding
 *                   for every guardrail failing together, since correlated metrics move for one cause.
 *                   Its id is the highest stage the ramp has reached (`regression:s<stage>`): a rollback, a fix
 *                   that doesn't work, or the same problem coming back after a re-advance keeps the same
 *                   finding and its attempts; reaching a new stage starts a new one
 *   blockers      : open child bugs, fix CLs not yet in prod, open pages, unanswered questions
 *                   (bug tracker / deploy system / pager / decision component)
 *   progress      : advance a stage only on a CLEAN frame         (no findings, no blockers, all pass, soaked)
 *   playbook      : regression → [rollback if severe] → triage → quick fix | child bug + recursive investigation
 *                                                               | escalate: page on-call, hold until they resolve it
 *   escalation    : a regression out of attempts or unresolved for 7 days is escalated the same way,
 *                   with a rollback to stage 0 while it waits for the person
 *   multi-arm     : each treatment arm ramps on its own. A regression is per arm (`regression:<arm>:s<stage>`),
 *                   and its bugs, fixes and pages hold only that arm, so the others keep ramping
 *
 * Everything the loop files is labeled with `exp:<flag>`, so a fresh run finds it. The one
 * thing the world can't show is which experiment this loop manages (the experiment service has no label for
 * it), so its id is a named fact in loop memory. Lose it, and the loop finds the experiments
 * on its flag and asks again whether to use the one it finds.
 */
import type { Blocker, Budget, EscalateAction, Finding, Frame, ReconcilerSpec } from '../core/types.js';
import type { Runtime } from '../core/runtime.js';
import { autoApprove, type Decisions, type Question } from '../core/decisions.js';
import { escalation, reconcileToEnd, type RunOptions } from '../core/reconcile.js';
import { DAY, HOUR, MIN } from '../core/time.js';
import type { InvestigationInput } from './investigation.js';
import { investigationId, type BugView, type FixView, type PageView, type SystemsActivities, type WorkflowStatus } from './systems.js';

export interface Stage { percent: number; soakMs: number }

/** The fields required to create an experiment. Plain JSON: it goes through questions and memory. */
export interface ExperimentConfig {
  flagName: string;
  featureName: string;
  launchLayer: string;
  /** Tracking bug for the launch. The experiment service won't create a second experiment on a flag with the same one. */
  launchBug: number;
  /** A ramp policy from the experiment service's definitions; it sets the stages. */
  rampPolicy: string;
  /** 'YYYY-MM-DD'. A string, not a Date, so it survives serialization. */
  expectedLaunchDate: string;
  owners: [string, ...string[]];
}

export interface ExperimentState {
  /** Assigned by the experiment service on create. Never an input. */
  id: string; flagName: string; launchBug: number;
  stages: Stage[]; stage: number; stageEnteredAt: number; status: 'running' | 'complete' | 'aborted';
  /** The highest stage this experiment has reached (from the experiment service's stage history). Rollbacks don't lower it. */
  peakStage: number;
  /** Multi-arm experiments: each treatment arm has its own stage. Absent for a single treatment. */
  arms?: ArmState[];
}
export interface ArmState { name: string; stage: number; stageEnteredAt: number; peakStage: number }
export interface GuardrailReading {
  guardrail: string; verdict: 'pass' | 'fail' | 'insufficient';
  value: number; threshold: number; severity: 'mild' | 'severe'; signature?: string;
  /** The arm this reading compares against control, in a multi-arm experiment. */
  arm?: string;
}
export type Triage =
  | { route: 'quick-fix'; patch: { summary: string; ref: string } }
  | { route: 'investigate'; title: string; hypothesis: string; signature?: string }
  | { route: 'escalate'; reason: string };

export interface ExperimentActivities extends SystemsActivities {
  /** Active experiments on this flag, whoever created them. May be empty or several. */
  findExperimentsByFlag(flagName: string): Promise<ExperimentState[]>;
  /** Agent: suggest the fields for a new experiment on this flag. Memoized; a person approves them. */
  draftExperiment(flagName: string): Promise<ExperimentConfig>;
  /** Returns the existing experiment if one on this flag already has this launch bug. Idempotent on `key`. */
  createExperiment(config: ExperimentConfig, key: string): Promise<ExperimentState>;
  getExperiment(expId: string): Promise<ExperimentState>;
  readGuardrails(expId: string): Promise<GuardrailReading[]>;
  /** Debugging playbook (agent): looks at every guardrail failing in a regression at once. Memoized per attempt. */
  triage(expId: string, failing: GuardrailReading[], attempt: number): Promise<Triage>;
  /** Set the experiment's stage, or one arm's stage in a multi-arm experiment. Idempotent on `key`. */
  setStage(expId: string, stage: number, key: string, arm?: string): Promise<void>;
  conclude(expId: string, key: string): Promise<void>;
  /** Terminal: the loop stopped short of its goal (out of time, or the plan said stop). */
  escalate(flagName: string, reason: string): Promise<void>;
  /** Page the experiment's on-call about one finding: how this loop escalates. Idempotent on `key`. */
  page(req: { key: string; parent: string; finding: string; reason: string }): Promise<string>;
  listPages(parent: string): Promise<PageView[]>;
}

export interface ExperimentInput {
  flagName: string;
  /** The time budget; 60 days unless the ramp needs longer (a long holdback). */
  maxDurationMs?: number;
  maxInvestigationDepth?: number;
  maxAttemptsPerBreach?: number;
}

export interface ExpWorld {
  /** The experiment this loop manages, once mounted. */
  exp?: ExperimentState;
  /** While unmounted: active experiments on the flag, and what the people asked have answered so far. */
  candidates: ExperimentState[]; mountChoice?: string; approvedConfig?: ExperimentConfig;
  readings: GuardrailReading[];
  bugs: BugView[]; fixes: FixView[]; pages: PageView[]; investigations: Record<string, WorkflowStatus>;
}
/** Every guardrail failing together for one treatment (one arm). Correlated metrics move for one cause. */
export interface RegressionData { failing: GuardrailReading[]; severity: 'mild' | 'severe'; arm?: string; peakStage: number }
type Regression = Finding<'regression', RegressionData>;
type Unmounted = Finding<'unmounted', null>;
type ExpFinding = Regression | Unmounted;
type ExpAction =
  | { key: string; kind: 'mount'; targets: string[]; experimentId: string }
  | { key: string; kind: 'create'; targets: string[]; config: ExperimentConfig }
  | { key: string; kind: 'rollback'; to: number; arm?: string }
  | { key: string; kind: 'submit-fix'; targets: string[]; patch: { summary: string; ref: string }; deadlineMs: number }
  | { key: string; kind: 'file-bug'; targets: string[]; title: string; signature: string; deadlineMs: number }
  | { key: string; kind: 'start-investigation'; bugId: string }
  | EscalateAction
  | { key: string; kind: 'advance'; to: number; arm?: string }
  | { key: string; kind: 'conclude' };

/** The named fact this loop keeps: the id of the experiment it manages. */
const EXPERIMENT_ID = 'experimentId';
const CREATE = 'create';

export function experimentSpec(
  rt: Runtime, acts: ExperimentActivities, input: ExperimentInput, decisions: Decisions = autoApprove,
): ReconcilerSpec<ExpWorld, ExpFinding, ExpAction, Triage> {
  const flag = input.flagName;
  const self = `exp:${flag}`;
  const budget: Budget = {
    maxDurationMs: input.maxDurationMs ?? 60 * DAY, // a ramp is finite
    maxAttemptsPerFinding: input.maxAttemptsPerBreach ?? 3,
    maxFindingAgeMs: 7 * DAY,
    retentionMs: 30 * DAY,
    escalationDeadlineMs: HOUR,
  };
  return {
    name: self,
    budget,

    async observe({ memo, facts }) {
      // Everything the loop filed is labeled with the flag, so it is found with or without the experiment id.
      const [bugs, fixes, pages] = await Promise.all([acts.listChildBugs(self), acts.listFixes(self), acts.listPages(self)]);
      const openBugs = bugs.filter((b) => b.status === 'open');
      const investigations = Object.fromEntries(
        await Promise.all(openBugs.map(async (b) => [b.id, await acts.workflowStatus(investigationId(b.id))] as const)),
      );
      // An arm's obligations hold only that arm (finding scope; plan checks each arm); everything else holds the loop.
      const scope = (finding: string) => (armOf(finding) ? 'finding' as const : 'loop' as const);
      const blockers: Blocker[] = [
        ...openBugs.map((b) => ({ id: `bug:${b.id}`, kind: 'child-bug', on: [b.finding], scope: scope(b.finding), summary: b.title, since: b.createdAt })),
        ...fixes.filter((x) => x.state !== 'in-prod').map((x) => ({ id: `deploy:${x.clId}`, kind: 'deploy', on: [x.finding], scope: scope(x.finding), summary: `${x.clId} rolling out` })),
        ...pages.filter((p) => p.status === 'open').map((p) => ({ id: `page:${p.id}`, kind: 'page', on: [p.finding], scope: scope(p.finding), summary: p.reason, since: p.openedAt })),
      ];
      const shared = { bugs, fixes, pages, investigations };

      const expId = facts[EXPERIMENT_ID] as string | undefined;
      if (!expId) {
        // Unmounted: use an experiment already on the flag, or create one. People decide; a
        // question waiting for an answer holds the loop.
        const ask = <C>(q: Question<C>) => {
          const answer = decisions.get(q);
          if (answer === undefined) blockers.push({ id: `question:${q.key}`, kind: 'question', on: ['unmounted'], scope: 'loop', summary: q.question });
          return answer;
        };
        const candidates = await acts.findExperimentsByFlag(flag);
        const mountChoice = candidates.length
          ? ask({
            key: `mount-or-create:${flag}`, kind: 'mount-or-create',
            question: `Manage an existing experiment on ${flag}, or create a new one?`,
            options: [...candidates.map((c) => c.id), CREATE], suggested: candidates.length === 1 ? candidates[0]!.id : undefined,
          })
          : CREATE;
        let approvedConfig: ExperimentConfig | undefined;
        if (mountChoice === CREATE) {
          const draft = await memo.get(`draft:${flag}`, () => acts.draftExperiment(flag));
          approvedConfig = ask({ key: `approve-config:${flag}`, kind: 'approve-config', question: `Create this experiment on ${flag}?`, options: [draft], suggested: draft });
        }
        return {
          world: { candidates, mountChoice, approvedConfig, readings: [], ...shared },
          findings: [{ id: 'unmounted', kind: 'unmounted', severity: 'blocking', summary: `no experiment mounted for ${flag}`, data: null }],
          blockers,
        };
      }

      const [exp, readings] = await Promise.all([acts.getExperiment(expId), acts.readGuardrails(expId)]);
      return {
        world: { exp, candidates: [], readings, ...shared },
        findings: regressions(exp, readings),
        blockers,
      };
    },

    async assess(open, { memo, attempts, facts }) {
      const out: Record<string, Triage> = {};
      for (const f of open) {
        if (f.kind !== 'regression') continue;
        const ep = (attempts[f.id] ?? 0) + 1;
        out[f.id] = await memo.get(`triage:${f.id}:${ep}`, () => acts.triage(facts[EXPERIMENT_ID] as string, f.data.failing, ep));
      }
      return out;
    },

    done: ({ world: { exp } }) => (exp?.status === 'complete' ? 'ramped to 100%' : exp?.status === 'aborted' ? 'aborted by owner' : undefined),

    plan(f) {
      const { exp, bugs, investigations } = f.world;
      const actions: ExpAction[] = [];

      // 1. Repair — level-triggered self-healing: open child bug, nobody investigating.
      for (const b of bugs.filter((b) => b.status === 'open'))
        if (investigations[b.id] === 'unknown' || investigations[b.id] === 'terminated')
          actions.push({ key: `start:${b.id}@${f.tick}`, kind: 'start-investigation', bugId: b.id });

      // Mounting or creating the experiment is repair too: once people have answered.
      if (!exp) {
        const unmounted = f.open.find((x) => x.kind === 'unmounted');
        if (unmounted) {
          const n = (f.attempts[unmounted.id] ?? 0) + 1;
          const { mountChoice, approvedConfig } = f.world;
          if (mountChoice && mountChoice !== CREATE) actions.push({ key: `mount:${mountChoice}:${n}`, kind: 'mount', targets: [unmounted.id], experimentId: mountChoice });
          else if (approvedConfig) actions.push({ key: `create:${flag}:${n}`, kind: 'create', targets: [unmounted.id], config: approvedConfig });
        }
        return { actions, wake: { afterMs: HOUR, signals: ['answered', 'child-closed'] }, note: f.held ? `unmounted; held by ${f.blockers.map((b) => b.id).join(',')}` : 'unmounted' };
      }

      // 2. Mitigate locally while a person takes over: the loop files the escalation (a page);
      // the rollback names no targets, so it doesn't use up one of the breach's attempts.
      for (const e of f.escalating) {
        const arm = armOf(e.finding.id);
        if (stageOf(exp, arm) > 0) actions.push({ key: `safe-hold:${e.finding.id}:${(f.attempts[e.finding.id] ?? 0) + 1}`, kind: 'rollback', to: 0, arm });
      }

      // 3. Respond — debugging playbook for each breach nobody is handling.
      for (const x of f.open) {
        if (x.kind !== 'regression') continue;
        const ep = (f.attempts[x.id] ?? 0) + 1;
        const t = f.assessments[x.id]!;
        const arm = x.data.arm;
        if (x.data.severity === 'severe' && stageOf(exp, arm) > 0) actions.push({ key: `rollback:${x.id}:${ep}`, kind: 'rollback', to: stageOf(exp, arm) - 1, arm });
        // Hold, don't halt: the page is a loop-scoped blocker until on-call resolves it. If the
        // breach is still there afterwards, it is triaged again as the next attempt.
        if (t.route === 'escalate') actions.push(escalation({ finding: x, reason: t.reason }, f, budget));
        if (t.route === 'quick-fix')
          actions.push({ key: `fix:${x.id}:${ep}`, kind: 'submit-fix', targets: [x.id], patch: t.patch, deadlineMs: HOUR });
        if (t.route === 'investigate')
          actions.push({ key: `bug:${x.id}:${ep}`, kind: 'file-bug', targets: [x.id], title: t.title, signature: t.signature ?? x.id, deadlineMs: HOUR });
      }

      // 4. Progress — only on a clean frame. With several arms, each arm on its own clean slice.
      if (exp.arms) return progressArms(f, exp, exp.arms, actions);
      if (!f.findings.length && !f.blockers.length && exp.status === 'running') {
        const soakLeft = exp.stageEnteredAt + exp.stages[exp.stage]!.soakMs - f.now;
        if (f.world.readings.every((r) => r.verdict === 'pass') && soakLeft <= 0) {
          actions.push(exp.stage < exp.stages.length - 1
            ? { key: `advance:${exp.stage}->${exp.stage + 1}@${exp.stageEnteredAt}`, kind: 'advance', to: exp.stage + 1 }
            : { key: 'conclude', kind: 'conclude' });
        }
        return { actions, wake: { afterMs: clamp(soakLeft, 15 * MIN, 6 * HOUR) }, note: `stage ${exp.stage}, soak left ${Math.max(0, soakLeft)}` };
      }
      return { actions, wake: wakeWhileHeld(f), note: f.held ? `held by ${f.blockers.map((b) => b.id).join(',')}` : undefined };
    },

    async act(a, f, facts) {
      const expId = () => f.world.exp!.id;
      switch (a.kind) {
        // The only place the experiment id is written.
        case 'mount': facts[EXPERIMENT_ID] = a.experimentId; break;
        case 'create': facts[EXPERIMENT_ID] = (await acts.createExperiment(a.config, `${self}/${a.key}`)).id; break;
        case 'rollback': await acts.setStage(expId(), a.to, `${self}/${a.key}`, a.arm); break;
        case 'advance': await acts.setStage(expId(), a.to, `${self}/${a.key}`, a.arm); break;
        case 'conclude': await acts.conclude(expId(), `${self}/${a.key}`); break;
        case 'submit-fix':
          await acts.submitFix({ key: `${self}/${a.key}`, parent: self, finding: a.targets[0]!, patch: a.patch });
          break;
        case 'file-bug':
          await acts.fileBug({ key: `${self}/${a.key}`, parent: self, finding: a.targets[0]!, title: a.title, signature: a.signature, depth: 1 });
          break;
        case 'start-investigation':
          await rt.startChild({
            workflowId: investigationId(a.bugId), workflow: 'investigation',
            input: { bugId: a.bugId, parentWorkflowId: rt.workflowId, depth: 1, maxDepth: input.maxInvestigationDepth ?? 3 } satisfies InvestigationInput,
          });
          break;
        case 'escalate':
          await acts.page({ key: `${self}/${a.key}`, parent: self, finding: a.finding, reason: a.reason });
          break;
      }
    },
  };
}

/**
 * Group failing guardrails into one regression per treatment (per arm). The id is the highest
 * stage reached: stable while the set of failing metrics changes, through rollbacks, fixes that
 * don't work, and the same problem recurring after a re-advance; new once the ramp reaches a
 * stage it never had. (The time of the last advance would treat each recurrence as new, with
 * fresh attempts and a fresh age, so a problem nobody can fix would never age out.)
 */
function regressions(exp: ExperimentState, readings: GuardrailReading[]): Regression[] {
  const groups = exp.arms ? exp.arms.map((a) => ({ arm: a.name as string | undefined, peakStage: a.peakStage })) : [{ arm: undefined, peakStage: exp.peakStage }];
  return groups.flatMap(({ arm, peakStage }) => {
    const failing = readings.filter((r) => r.arm === arm && r.verdict === 'fail');
    if (!failing.length) return [];
    return [{
      id: `regression:${arm ? `${arm}:` : ''}s${peakStage}`, kind: 'regression' as const, severity: 'blocking' as const,
      summary: `${arm ? `${arm}: ` : ''}${failing.map((r) => r.guardrail).join(', ')} failing`,
      data: { failing, severity: failing.some((r) => r.severity === 'severe') ? 'severe' as const : 'mild' as const, arm, peakStage },
    }];
  });
}
/** The arm a finding belongs to, for per-arm regressions (`regression:<arm>:s<stage>`). */
const armOf = (finding: string) => { const p = finding.split(':'); return p[0] === 'regression' && p.length === 3 ? p[1] : undefined; };
const stageOf = (exp: ExperimentState, arm?: string) => (arm ? exp.arms!.find((a) => a.name === arm)!.stage : exp.stage);

/**
 * Progress for a multi-arm experiment. Each arm advances on its own clean slice of the frame:
 * no finding, blocker or claim of its own, all its readings passing, its soak time up. Nothing
 * advances while the whole loop is held (a question, say). Conclude once every arm is at the
 * last stage and clean.
 */
function progressArms(f: Frame<ExpWorld, ExpFinding, Triage>, exp: ExperimentState, arms: ArmState[], actions: ExpAction[]) {
  const mine = (arm: string, ids: string[]) => ids.some((id) => armOf(id) === arm);
  const last = exp.stages.length - 1;
  let wakeMs = 6 * HOUR;
  const clean: string[] = [];
  for (const a of arms) {
    const busy = f.findings.some((x) => armOf(x.id) === a.name) || f.blockers.some((b) => mine(a.name, b.on)) || f.claimed.some((x) => armOf(x.id) === a.name);
    const passing = f.world.readings.filter((r) => r.arm === a.name).every((r) => r.verdict === 'pass');
    const soakLeft = a.stageEnteredAt + exp.stages[a.stage]!.soakMs - f.now;
    if (busy || f.held || exp.status !== 'running') continue;
    wakeMs = Math.min(wakeMs, Math.max(soakLeft, 15 * MIN));
    if (!passing || soakLeft > 0) continue;
    if (a.stage < last) actions.push({ key: `advance:${a.name}:${a.stage}->${a.stage + 1}@${a.stageEnteredAt}`, kind: 'advance', to: a.stage + 1, arm: a.name });
    else clean.push(a.name);
  }
  if (clean.length === arms.length) actions.push({ key: 'conclude', kind: 'conclude' });
  const busy = f.blockers.length || f.claimed.length;
  return {
    actions, wake: busy ? { ...wakeWhileHeld(f), afterMs: Math.min(wakeWhileHeld(f).afterMs, wakeMs) } : { afterMs: wakeMs },
    note: arms.map((a) => `${a.name}@${a.stage}`).join(' '),
  };
}

/** Deploys and pages resolve in hours; investigations take days, and they hint us when done. */
function wakeWhileHeld(f: Frame<ExpWorld, ExpFinding, Triage>) {
  if (f.claimed.length) return { afterMs: 5 * MIN }; // an intent is in flight; expect the world to catch up soon
  const soon = f.blockers.some((b) => b.kind === 'deploy' || b.kind === 'page');
  return { afterMs: soon ? HOUR : 6 * HOUR, signals: ['child-closed'] };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Workflow id convention: `experiment:<flag>`, so a restart reuses it and child hints still land. */
export const experimentWorkflowId = (flagName: string) => `experiment:${flagName}`;

export async function experimentWorkflow(
  rt: Runtime, acts: ExperimentActivities, input: ExperimentInput & { memory?: any },
  opts: RunOptions & { decisions?: Decisions } = {},
) {
  const out = await reconcileToEnd(rt, experimentSpec(rt, acts, input, opts.decisions), { maxTicksPerRun: 100, memory: input.memory, ...opts });
  if (out.status !== 'done') {
    // Safe hold: out of time, or the plan said stop. Back to stage 0, and a person takes over.
    const expId = out.memory.facts[EXPERIMENT_ID] as string | undefined;
    if (expId) await acts.setStage(expId, 0, `exp:${input.flagName}/safe-hold`);
    await acts.escalate(input.flagName, out.reason);
  }
  return out.status === 'done' ? { status: 'done', reason: out.reason } : { status: out.status };
}
