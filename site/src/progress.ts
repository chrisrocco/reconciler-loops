import { useCallback, useEffect, useState } from 'react';

/**
 * Quiz progress, per viewer, in localStorage. Storage can be missing or throw (private
 * windows, blocked site data), so every access is guarded and the site works without it.
 */
const KEY = 'reconciler-loops:progress:v1';
type Progress = Record<string, { answered: Record<number, number>; done?: boolean }>;

function load(): Progress {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Progress; } catch { return {}; }
}
function save(p: Progress) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* not available: progress lives for this visit */ }
}

const listeners = new Set<() => void>();
let state: Progress = load();

export function useProgress() {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    listeners.add(on);
    return () => { listeners.delete(on); };
  }, []);
  const answer = useCallback((lesson: string, q: number, choice: number, done: boolean) => {
    const prev = state[lesson] ?? { answered: {} };
    state = { ...state, [lesson]: { answered: { ...prev.answered, [q]: choice }, done: prev.done || done } };
    save(state);
    listeners.forEach((l) => l());
  }, []);
  const reset = useCallback(() => { state = {}; save(state); listeners.forEach((l) => l()); }, []);
  return { progress: state, answer, reset };
}
