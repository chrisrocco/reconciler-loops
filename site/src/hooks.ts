import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Width of an element, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Advance a playhead through [start, end] in about `seconds / speed` of wall-clock time. */
export function usePlayback(start: number, end: number, t: number, setT: (t: number) => void, seconds = 24) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!playing || end <= start) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const next = tRef.current + ((now - last) / 1000) * ((end - start) / seconds) * speed;
      last = now;
      if (next >= end) { setT(end); setPlaying(false); return; }
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, start, end, seconds, setT]);

  const toggle = () => {
    if (!playing && (tRef.current >= end || tRef.current < start)) setT(start);
    setPlaying((p) => !p);
  };
  return { playing, setPlaying, toggle, speed, setSpeed };
}
