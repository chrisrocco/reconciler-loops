import { useEffect, useRef } from 'react';
import { fmt } from '../../../src/runtime/sim';
import type { LogEvent } from '../sims/trace';

export function EventLog({ events, t, onSeek }: { events: LogEvent[]; t: number; onSeek: (t: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const past = events.filter((e) => e.at <= t).length;
  const nowAt = past ? events[past - 1]!.at : -1;

  // Keep the latest past event in view as the playhead moves.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[Math.max(0, past - 1)] as HTMLElement | undefined;
    if (list && row) list.scrollTop = row.offsetTop - list.clientHeight + row.offsetHeight + 8;
  }, [past]);

  return (
    <div ref={listRef} className="log">
      {events.map((e, i) => (
        <button key={i} className={`log-row ${e.kind} ${i >= past ? 'future' : ''} ${e.at === nowAt ? 'now' : ''}`} onClick={() => onSeek(e.at)}>
          <span className="log-time mono">{fmt(e.at)}</span>
          <span className="log-wf mono">{e.wf}</span>
          <span className="log-text">{e.text}</span>
        </button>
      ))}
    </div>
  );
}
