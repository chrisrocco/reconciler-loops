import type { WorldStats } from '../../../../src/fakes/realistic/world';

const GROUPS: { title: string; items: [keyof WorldStats, string][] }[] = [
  { title: 'Infrastructure', items: [['rpcErrors', 'transient RPC errors (retried)'], ['ambiguousCreates', 'bug creates that timed out after committing'], ['statusLag', 'workflow describe() lagging a fresh start'], ['staleReadouts', 'stale metric readouts']] },
  { title: 'Agents', items: [['falseAlarms', 'triage of a false-positive breach'], ['misroutes', 'triage picked the wrong route'], ['rcaInconclusive', 'inconclusive RCA'], ['rcaWrong', 'wrong root cause'], ['rcaMissedPrereq', 'RCA missed a prerequisite'], ['fixesIneffective', 'live fixes verification caught not working'], ['verifyWrong', 'wrong verification verdicts']] },
  { title: 'People', items: [['duplicateBugs', 'bugs marked duplicate by the triager'], ['pages', 'pages answered by on-call'], ['humanInterventions', 'investigations handed to on-call'], ['humanFixes', 'fixes shipped by people'], ['reviewRounds', 'extra code-review rounds']] },
  { title: 'Release', items: [['presubmitFlakes', 'flaky presubmit reruns'], ['presubmitFailures', 'presubmit failures'], ['qualificationFailures', 'failed release qualifications'], ['releaseRollbacks', 'release rollbacks']] },
];

export function Friction({ stats }: { stats: WorldStats }) {
  return (
    <div className="friction">
      {GROUPS.map((g) => (
        <div key={g.title} className="friction-group">
          <div className="friction-title">{g.title}</div>
          {g.items.map(([k, label]) => (
            <div key={k} className={`friction-row ${stats[k] ? '' : 'zero'}`}>
              <span className="friction-n mono">{stats[k]}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
