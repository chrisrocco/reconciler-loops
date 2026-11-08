import { useEffect, useState } from 'react';

/** Hash routes, so the built site works from any static host or folder. */
export type Route =
  | { page: 'home' }
  | { page: 'learn'; lesson?: string }
  | { page: 'simulate'; sim?: string; variant?: string }
  | { page: 'case-study'; sim: string }
  | { page: 'playbook'; doc?: string };

export function parse(hash: string): Route {
  const [page, a, b] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (page === 'learn') return { page: 'learn', lesson: a || undefined };
  if (page === 'simulate') return { page: 'simulate', sim: a || undefined, variant: b || undefined };
  if (page === 'case-study' && a) return { page: 'case-study', sim: a };
  if (page === 'playbook') return { page: 'playbook', doc: a || undefined };
  return { page: 'home' };
}

export function href(r: Route): string {
  if (r.page === 'learn') return `#/learn${r.lesson ? `/${r.lesson}` : ''}`;
  if (r.page === 'case-study') return `#/case-study/${r.sim}`;
  if (r.page === 'playbook') return `#/playbook${r.doc ? `/${r.doc}` : ''}`;
  if (r.page === 'simulate') return `#/simulate${r.sim ? `/${r.sim}${r.variant ? `/${encodeURIComponent(r.variant)}` : ''}` : ''}`;
  return '#/';
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parse(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (r: Route) => { window.location.hash = href(r); };
