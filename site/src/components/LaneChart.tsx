import { useRef, type PointerEvent } from 'react';
import { DAY, HOUR, fmt } from '../../../src/runtime/sim';
import { useWidth } from '../hooks';
import type { Lane, Tick } from '../sims/trace';

interface Props {
  lanes: Lane[];
  from: number; to: number; t: number;
  selectedLane?: string; selectedTick?: Tick;
  onSeek: (t: number) => void;
  onSelectTick: (t: Tick) => void;
  onSelectLane: (wf: string) => void;
  /** Short display names for long workflow ids. */
  label?: (wf: string) => string;
}

const LABEL_W = 190, ROW = 24, AXIS = 22;

/**
 * One row per loop: its runs, the spans it was held, and its ticks as dots (green: acted,
 * ring: woken early by a hint, red diamond: escalated a finding to a person).
 */
export function LaneChart({ lanes, from, to, t, selectedLane, selectedTick, onSeek, onSelectTick, onSelectLane, label = (wf) => wf }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const W = Math.max(320, width), plotW = W - LABEL_W - 12;
  const x = (v: number) => LABEL_W + ((v - from) / Math.max(1, to - from)) * plotW;
  const H = AXIS + lanes.length * ROW + 8;
  const span = to - from;
  // Labels at least ~90px apart.
  const step = [HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY].find((s) => (s / Math.max(1, span)) * plotW >= 90) ?? 30 * DAY;
  const ticksAxis: number[] = [];
  for (let v = Math.ceil(from / step) * step; v <= to; v += step) ticksAxis.push(v);

  const seekFrom = (e: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px >= LABEL_W) onSeek(from + ((px - LABEL_W) / plotW) * span);
  };

  return (
    <div ref={ref} className="timeline">
      <svg ref={svgRef} width={W} height={H} onPointerDown={(e) => { if ((e.target as Element).classList.contains('hit-area')) { seekFrom(e); (e.target as Element).setPointerCapture(e.pointerId); } }}
        onPointerMove={(e) => { if (e.buttons === 1 && (e.target as Element).classList.contains('hit-area')) seekFrom(e); }}>
        {ticksAxis.map((v) => (
          <g key={v}>
            <line className="grid" x1={x(v)} x2={x(v)} y1={AXIS - 4} y2={H} />
            <text className="axis-text" x={x(v) + 3} y={12}>{fmt(v).replace('+00:00', '')}</text>
          </g>
        ))}
        <rect className="hit-area hit" x={LABEL_W} y={0} width={plotW} height={H} />
        {lanes.map((l, i) => {
          const y = AXIS + i * ROW;
          const cy = y + ROW / 2;
          const dense = l.ticks.length > plotW / 3;
          return (
            <g key={l.wf}>
              <rect className={`lane-bg ${l.wf === selectedLane ? 'selected' : ''}`} x={0} y={y} width={W} height={ROW} />
              <rect className="lane-label-hit" x={0} y={y} width={LABEL_W} height={ROW} onClick={() => onSelectLane(l.wf)} />
              <text className="lane-label" x={8 + Math.min(l.depth, 3) * 12} y={cy + 4}>{clip(label(l.wf), 26 - Math.min(l.depth, 3) * 2)}</text>
              {l.runs.map((r, j) => (
                <rect key={j} className="run-bar" x={x(Math.max(from, r.start))} y={cy - 1} height={2}
                  width={Math.max(0, x(Math.min(to, r.end ?? to)) - x(Math.max(from, r.start)))} />
              ))}
              {heldSpans(l.ticks, to).map(([a, b], j) => b > from && a < to && (
                <rect key={j} className="held-band" x={x(Math.max(from, a))} y={y + 4} height={ROW - 8} width={Math.max(1, x(Math.min(to, b)) - x(Math.max(from, a)))} />
              ))}
              {l.ticks.filter((k) => k.at >= from && k.at <= to && (!dense || k.acted.length || k.woke?.startsWith('signal'))).map((k) => {
                const esc = k.acted.some((a) => a.startsWith('escalate:'));
                const cls = esc ? '' : k.acted.length ? 'dot-acted' : k.woke?.startsWith('signal') ? 'dot-signal' : 'dot-idle';
                return (
                  <g key={k.idx} className="tick" onClick={() => onSelectTick(k)}>
                    <circle className="hit" cx={x(k.at)} cy={cy} r={6} />
                    {esc ? <path className="esc-mark" d={`M${x(k.at)} ${cy - 5} l5 5 l-5 5 l-5 -5 z`} />
                      : <circle className={cls} cx={x(k.at)} cy={cy} r={k.acted.length ? 3.6 : k.woke?.startsWith('signal') ? 3.4 : 1.6} />}
                  </g>
                );
              })}
              {selectedTick && selectedTick.wf === l.wf && <circle className="dot-selected" cx={x(selectedTick.at)} cy={cy} r={6.5} />}
              {l.runs.map((r, j) => r.outcome && r.end !== undefined && r.end <= to && (
                <text key={`o${j}`} className={`outcome-text ${r.outcome}`} x={x(r.end) > W - 90 ? x(r.end) - 10 : x(r.end) + 6} textAnchor={x(r.end) > W - 90 ? 'end' : 'start'} y={cy + 4}>{r.outcome === 'terminated' ? '✕' : r.outcome}</text>
              ))}
            </g>
          );
        })}
        <rect className="future" x={x(t)} y={AXIS - 4} width={Math.max(0, x(to) - x(t))} height={H} />
        <line className="playhead" x1={x(t)} x2={x(t)} y1={AXIS - 6} y2={H} />
      </svg>
    </div>
  );
}

/** Spans where a lane's ticks saw a loop-scoped blocker. */
function heldSpans(ticks: Tick[], end: number): [number, number][] {
  const out: [number, number][] = [];
  let start: number | undefined;
  ticks.forEach((k, i) => {
    if (k.held && start === undefined) start = k.at;
    if (!k.held && start !== undefined) { out.push([start, k.at]); start = undefined; }
    if (i === ticks.length - 1 && start !== undefined) out.push([start, Math.min(end, k.at + HOUR)]);
  });
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
