import { useRef, type PointerEvent } from 'react';
import { DAY, HOUR, fmt } from '../../../../src/runtime/sim';
import { dayOfWeek } from '../../../../src/fakes/realistic/calendar';
import { EXP, type BugRow, type FixRow, type Lane, type SimRun, type Tick } from './run';
import { useWidth } from '../../hooks';

const LABEL_W = 226;
const PAD_R = 24;
const AXIS_H = 28;
const HEADER_H = 24;
const ROLLOUT_H = 92;
const LANE_H = 34;
const ROW_H = 24;
const GAP = 18;
const CHAR_W = 6.4;

interface Props {
  run: SimRun;
  /** Visible window of simulation time. */
  from: number;
  to: number;
  t: number;
  onSeek: (t: number) => void;
  selectedLane: string;
  selectedTick?: Tick;
  onSelectTick: (tick: Tick) => void;
  onSelectLane: (wf: string) => void;
}

export function Timeline({ run, from, to, t, onSeek, selectedLane, selectedTick, onSelectTick, onSelectLane }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const end = Math.max(run.end, HOUR);
  const span = Math.max(to - from, HOUR);
  const plotW = Math.max(100, width - LABEL_W - PAD_R);
  const x = (ms: number) => LABEL_W + ((Math.min(ms, end) - from) / span) * plotW;
  const plotRight = LABEL_W + plotW;
  const px = x(t);
  const inView = px >= LABEL_W && px <= plotRight;

  // Vertical layout.
  const rolloutTop = AXIS_H + HEADER_H;
  const rolloutBottom = rolloutTop + ROLLOUT_H;
  const lanesHeader = rolloutBottom + GAP;
  const lanesTop = lanesHeader + HEADER_H;
  const lanesBottom = lanesTop + run.lanes.length * LANE_H;
  const systemsHeader = lanesBottom + GAP;
  const systemsTop = systemsHeader + HEADER_H;
  const rows = run.bugs.length + run.fixes.length;
  const height = systemsTop + Math.max(1, rows) * ROW_H + 10;

  const tFromEvent = (e: PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return Math.max(from, Math.min(to, from + ((e.clientX - rect.left - LABEL_W) / plotW) * span));
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(tFromEvent(e));
  };
  const onMove = (e: PointerEvent) => { if (dragging.current) onSeek(tFromEvent(e)); };
  const onUp = () => { dragging.current = false; };

  const expLane = run.lanes.find((l) => l.wf === EXP);
  const expEnd = expLane?.runs.at(-1)?.end ?? end;

  return (
    <div ref={wrapRef} className="timeline">
      {width > 0 && (
        <svg ref={svgRef} width={width} height={height} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" strokeWidth="3" />
            </pattern>
            {/* Plot content outside the visible window is clipped; labels sit left of it. */}
            <clipPath id="plot">
              <rect x={LABEL_W - 12} y={0} width={plotW + PAD_R + 12} height={height} />
            </clipPath>
          </defs>

          <Weekends from={from} to={to} x={x} height={height} />
          <Axis from={from} to={to} x={x} plotW={plotW} height={height} />

          {/* ── Rollout ── */}
          <SectionHeader y={AXIS_H} label="Rollout" hint="experiment stage over time · red = guardrail failing" />
          <g clipPath="url(#plot)">
            {run.outages.map((o, i) => (
              <g key={i}>
                <rect x={x(o.from)} y={rolloutTop} width={Math.max(2, x(o.to) - x(o.from))} height={ROLLOUT_H} className="stalled-band" />
                <text x={x(o.from) + 4} y={rolloutTop + ROLLOUT_H - 6} className="stalled-text">metrics stalled</text>
              </g>
            ))}
          </g>
          {[0, 50, 100].map((p) => {
            const y = rolloutTop + ROLLOUT_H - (p / 100) * ROLLOUT_H;
            return (
              <g key={p}>
                <line x1={LABEL_W} x2={plotRight} y1={y} y2={y} className="grid" />
                <text x={LABEL_W - 8} y={y + 4} textAnchor="end" className="axis-text">{p}%</text>
              </g>
            );
          })}
          <g clipPath="url(#plot)">
            <FailBands run={run} x={x} top={rolloutTop} height={ROLLOUT_H} expEnd={expEnd} />
            <Rollout run={run} x={x} top={rolloutTop} height={ROLLOUT_H} expEnd={expEnd} />
          </g>

          {/* ── Workflows ── */}
          <SectionHeader y={lanesHeader} label="Reconciler loops" hint="one lane per workflow · dots are ticks" />
          {run.lanes.map((lane, i) => (
            <LaneRow
              key={lane.wf} lane={lane} y={lanesTop + i * LANE_H} x={x} end={end} width={width}
              selected={lane.wf === selectedLane} selectedTick={selectedTick}
              onSelectTick={onSelectTick} onSelectLane={onSelectLane}
            />
          ))}

          {/* ── Systems of record ── */}
          <SectionHeader y={systemsHeader} label="Systems of record" hint="what the loops observe as blockers" />
          {rows === 0 && <text x={LABEL_W} y={systemsTop + 16} className="muted-text">No bugs filed, no fix CLs submitted.</text>}
          {run.bugs.map((b, i) => <BugRowView key={b.id} b={b} y={systemsTop + i * ROW_H} x={x} end={end} />)}
          {run.fixes.map((f, i) => <FixRowView key={f.id} f={f} y={systemsTop + (run.bugs.length + i) * ROW_H} x={x} end={end} />)}

          {/* ── Playhead ── */}
          {px <= plotRight && (
            <rect x={Math.max(LABEL_W, px)} y={AXIS_H} width={plotRight + PAD_R - Math.max(LABEL_W, px)} height={height - AXIS_H} className="future" />
          )}
          {inView && (
            <>
              <line x1={px} x2={px} y1={AXIS_H - 4} y2={height} className="playhead" />
              <g transform={`translate(${Math.min(Math.max(px, LABEL_W + 30), width - 34)}, 12)`}>
                <rect x={-32} y={-10} width={64} height={18} rx={9} className="playhead-pill" />
                <text y={3} textAnchor="middle" className="playhead-text">{fmt(t)}</text>
              </g>
            </>
          )}
        </svg>
      )}
    </div>
  );
}

function SectionHeader({ y, label, hint }: { y: number; label: string; hint: string }) {
  return (
    <g>
      <text x={14} y={y + 16} className="section-label">{label}</text>
      <text x={LABEL_W} y={y + 16} className="section-hint">{hint}</text>
    </g>
  );
}

function Axis({ from, to, x, plotW, height }: { from: number; to: number; x: (ms: number) => number; plotW: number; height: number }) {
  const steps = [2 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
  const step = steps.find((s) => (s / (to - from)) * plotW >= 56) ?? 7 * DAY;
  const ticks: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to; v += step) ticks.push(v);
  return (
    <g>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={AXIS_H} y2={height} className="grid" />
          <text x={x(v)} y={AXIS_H - 8} textAnchor="middle" className="axis-text">
            {step >= DAY ? `d${Math.round(v / DAY)}` : fmt(v).replace('+', ' ')}
          </text>
        </g>
      ))}
    </g>
  );
}

function Rollout({ run, x, top, height, expEnd }: { run: SimRun; x: (ms: number) => number; top: number; height: number; expEnd: number }) {
  // A multi-arm experiment draws one line per arm.
  const arms = [...new Set(run.stages.map((s) => s.arm).filter(Boolean))] as string[];
  if (arms.length) return (
    <g>{arms.map((a, i) => <RolloutLine key={a} stages={run.stages.filter((s) => s.arm === a)} arm={a} index={i} x={x} top={top} height={height} expEnd={expEnd} />)}</g>
  );
  return <RolloutLine stages={run.stages} x={x} top={top} height={height} expEnd={expEnd} />;
}

function RolloutLine({ stages: s, arm, index = 0, x, top, height, expEnd }: { stages: SimRun['stages']; arm?: string; index?: number; x: (ms: number) => number; top: number; height: number; expEnd: number }) {
  const y = (p: number) => top + height - (p / 100) * height + index * 3;
  if (!s.length) return null;
  let d = `M ${x(s[0]!.at)} ${y(s[0]!.percent)}`;
  for (const p of s.slice(1)) d += ` H ${x(p.at)} V ${y(p.percent)}`;
  d += ` H ${x(expEnd)}`;
  const area = `${d} V ${y(0)} H ${x(s[0]!.at)} Z`;
  return (
    <g>
      {!arm && <path d={area} className="rollout-area" />}
      <path d={d} className={`rollout-line ${arm ? `arm arm-${index}` : ''}`} />
      {arm && <text x={x(expEnd) + 4} y={y(s.at(-1)!.percent) + 4} className={`arm-label arm-${index}`}>{arm}</text>}
      {s.slice(1).map((p, i) => {
        const back = p.percent < s[i]!.percent;
        return (
          <g key={i}>
            <circle cx={x(p.at)} cy={y(p.percent)} r={4} className={back ? 'stage-dot back' : 'stage-dot'} />
            <text x={x(p.at) + 6} y={y(p.percent) - 6} className={back ? 'stage-text back' : 'stage-text'}>
              {back ? `${arm ? `${arm} ` : ''}${p.key.includes('safe-hold') ? 'safe-hold' : 'rollback'} ${p.percent}%` : arm ? '' : `${p.percent}%`}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function FailBands({ run, x, top, height, expEnd }: { run: SimRun; x: (ms: number) => number; top: number; height: number; expEnd: number }) {
  const bands: { g: string; from: number; to: number }[] = [];
  const open = new Map<string, number>();
  for (const r of run.readings) {
    for (const g of r.readings) {
      if (g.verdict === 'fail' && !open.has(g.guardrail)) open.set(g.guardrail, r.at);
      if (g.verdict !== 'fail' && open.has(g.guardrail)) { bands.push({ g: g.guardrail, from: open.get(g.guardrail)!, to: r.at }); open.delete(g.guardrail); }
    }
  }
  for (const [g, from] of open) bands.push({ g, from, to: expEnd });
  return (
    <g>
      {bands.map((b, i) => (
        <g key={i}>
          <rect x={x(b.from)} y={top} width={Math.max(2, x(b.to) - x(b.from))} height={height} className="fail-band" />
          <text x={x(b.from) + 4} y={top + 12} className="fail-text">{b.g} failing</text>
        </g>
      ))}
    </g>
  );
}

interface LaneProps {
  lane: Lane; y: number; x: (ms: number) => number; end: number; width: number;
  selected: boolean; selectedTick?: Tick;
  onSelectTick: (tick: Tick) => void; onSelectLane: (wf: string) => void;
}

function LaneRow({ lane, y, x, end, width, selected, selectedTick, onSelectTick, onSelectLane }: LaneProps) {
  const cy = y + LANE_H / 2;
  const runEndAt = (at: number) => lane.runs.find((r) => r.start <= at && (r.end ?? Infinity) >= at)?.end ?? end;
  const spans = lane.ticks.map((tk, i) => ({ tk, to: Math.min(lane.ticks[i + 1]?.at ?? Infinity, runEndAt(tk.at)) }));
  const stop = (e: PointerEvent) => e.stopPropagation();

  return (
    <g>
      <rect x={0} y={y} width={width} height={LANE_H} className={selected ? 'lane-bg selected' : 'lane-bg'} />
      <rect x={0} y={y} width={LABEL_W} height={LANE_H} className="lane-label-hit" onPointerDown={(e) => { stop(e); onSelectLane(lane.wf); }} />
      <text x={14 + lane.depth * 16} y={cy + 4} className="lane-label">
        {lane.depth > 0 && <tspan className="muted-text">↳ </tspan>}
        <tspan className="mono">{lane.wf}</tspan>
      </text>

      <g clipPath="url(#plot)">
        {spans.map(({ tk, to }) =>
          tk.held ? <rect key={`h${tk.idx}`} x={x(tk.at)} y={cy - 11} width={Math.max(1, x(to) - x(tk.at))} height={22} className="held-band" />
          : tk.claimed.length ? <rect key={`c${tk.idx}`} x={x(tk.at)} y={cy - 11} width={Math.max(1, x(to) - x(tk.at))} height={22} className="claimed-band" />
          : null)}
  
        {lane.runs.map((r, i) => {
          const x1 = x(r.end ?? end);
          const nearEdge = x1 > width - 90;
          return (
            <g key={i}>
              <rect x={x(r.start)} y={cy - 2.5} width={Math.max(2, x1 - x(r.start))} height={5} rx={2.5} className="run-bar" />
              {r.outcome === 'terminated'
                ? <text x={x1} y={cy + 5} textAnchor="middle" className="terminated">✕</text>
                : r.outcome && <text x={nearEdge ? x1 - 8 : x1 + 8} y={cy - 9} textAnchor={nearEdge ? 'end' : 'start'} className={`outcome-text ${r.outcome}`}>{r.outcome}</text>}
            </g>
          );
        })}
  
        {lane.ticks.map((tk) => {
          const cx = x(tk.at);
          const isSel = selectedTick?.wf === tk.wf && selectedTick.idx === tk.idx;
          return (
            <g key={tk.idx} className="tick" onPointerDown={stop} onClick={() => onSelectTick(tk)}>
              {tk.woke?.startsWith('signal') && <circle cx={cx} cy={cy} r={8} className="dot-signal" />}
              {tk.acted.length
                ? <circle cx={cx} cy={cy} r={5} className="dot-acted" />
                : <circle cx={cx} cy={cy} r={2.6} className="dot-idle" />}
              {isSel && <circle cx={cx} cy={cy} r={11} className="dot-selected" />}
              <circle cx={cx} cy={cy} r={9} className="hit" />
            </g>
          );
        })}
      </g>
    </g>
  );
}

function Weekends({ from, to, x, height }: { from: number; to: number; x: (ms: number) => number; height: number }) {
  const days: number[] = [];
  for (let d = Math.floor(from / DAY); d * DAY < to; d++) if (dayOfWeek(d * DAY) >= 5) days.push(d);
  return (
    <g clipPath="url(#plot)">
      {days.map((d) => (
        <g key={d}>
          <rect x={x(d * DAY)} y={AXIS_H} width={Math.max(1, x((d + 1) * DAY) - x(d * DAY))} height={height - AXIS_H} className="weekend" />
          {dayOfWeek(d * DAY) === 5 && <text x={x(d * DAY) + 4} y={AXIS_H + 12} className="weekend-text">weekend</text>}
        </g>
      ))}
    </g>
  );
}

const CLOSED_LABEL: Record<string, string> = {
  fixed: '✓ fixed', FIXED: '✓ FIXED', VERIFIED: '✓ VERIFIED', wontfix: 'wontfix', WONTFIX: 'WONTFIX',
  INFEASIBLE: 'INFEASIBLE', INTENDED_BEHAVIOR: 'intended behavior', OBSOLETE: 'obsolete',
};

function BugRowView({ b, y, x, end }: { b: BugRow; y: number; x: (ms: number) => number; end: number }) {
  const x0 = x(b.createdAt), x1 = x(b.closedAt ?? end);
  const fit = Math.floor((x1 - x0 - 10) / CHAR_W);
  const label = b.status === 'DUPLICATE' ? `dup of ${b.duplicateOf}` : CLOSED_LABEL[b.status] ?? b.status;
  const by = b.closedBy && b.closedBy !== 'agent' ? ` (${b.closedBy})` : '';
  return (
    <g>
      <text x={14 + (b.depth - 1) * 14} y={y + 16} className="row-label"><tspan className="mono">{b.id}</tspan> bug</text>
      <g clipPath="url(#plot)">
        <rect x={x0} y={y + 4} width={Math.max(2, x1 - x0)} height={ROW_H - 8} rx={4} className={b.closedAt ? 'bug-bar' : 'bug-bar open'} />
        {fit > 6 && <text x={x0 + 6} y={y + 16} className="bar-text">{clip(b.title, fit)}</text>}
        {b.closedAt !== undefined && <text x={x1 + 6} y={y + 16} className={b.status.toLowerCase().includes('fixed') || b.status === 'VERIFIED' ? 'bar-after' : 'bar-after other'}>{label}{by}</text>}
      </g>
    </g>
  );
}

/** Pipeline phase → how it is drawn. */
const phaseClass = (label: string) =>
  /canary|wave/.test(label) ? 'ph-rollout' : /cut|qualif|rolled back/.test(label) ? 'ph-wait' : 'ph-review';

function FixRowView({ f, y, x, end }: { f: FixRow; y: number; x: (ms: number) => number; end: number }) {
  const cy = y + ROW_H / 2;
  const deployed = f.inProdAt !== undefined && f.inProdAt <= end;
  const abandoned = f.state === 'abandoned';
  const segs = f.phases?.length
    ? f.phases.filter((p) => p.to !== p.from).map((p, i, all) => ({ ...p, to: p.to ?? all[i + 1]?.from ?? (deployed ? f.inProdAt! : end) }))
    : [{ label: 'rolling out', from: f.submittedAt, to: deployed ? f.inProdAt! : end }];
  const x0 = x(f.submittedAt);
  const x1 = x(deployed ? f.inProdAt! : segs.at(-1)!.to);
  const fit = Math.floor((x1 - x0 - 10) / CHAR_W);
  return (
    <g>
      <text x={14} y={y + 16} className="row-label">
        <tspan className="mono">{f.id}</tspan> {f.author === 'human' ? 'human fix' : 'fix CL'}
      </text>
      <g clipPath="url(#plot)">
        {segs.map((s, i) => {
          const cls = phaseClass(s.label);
          return (
            <rect key={i} x={x(s.from)} y={y + 4} width={Math.max(1.5, x(s.to) - x(s.from))} height={ROW_H - 8}
              fill={cls === 'ph-rollout' ? 'url(#hatch)' : undefined} className={`fix-seg ${cls}`}>
              <title>{`${s.label}: ${fmt(s.from)} → ${fmt(s.to)}`}</title>
            </rect>
          );
        })}
        {fit > 6 && <text x={x0 + 6} y={y + 16} className="bar-text">{clip(`${f.parent} · ${f.ref.startsWith('noop') ? 'fixes nothing' : `fixes ${f.ref}`}`, fit)}</text>}
        {deployed && (
          <>
            <line x1={x1} x2={x(end)} y1={cy} y2={cy} className="fix-live" />
            <circle cx={x1} cy={cy} r={3.5} className="fix-dot" />
          </>
        )}
        {abandoned && <text x={x1 + 6} y={y + 16} className="bar-after other">abandoned</text>}
      </g>
    </g>
  );
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`);
