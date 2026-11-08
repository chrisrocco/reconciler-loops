import { href, useRoute } from './router';
import { Home } from './pages/Home';
import { Learn } from './pages/Learn';
import { Simulate } from './pages/Simulate';
import { CaseStudy } from './pages/CaseStudy';
import { Playbook } from './pages/Playbook';

export function App() {
  const route = useRoute();
  return (
    <>
      <nav className="site-nav" aria-label="Site">
        <a className="site-logo" href={href({ page: 'home' })}>
          <LoopMark /> Reconciler Loops
        </a>
        <div className="site-links">
          <a className={route.page === 'learn' ? 'on' : ''} href={href({ page: 'learn' })}>Learn</a>
          <a className={route.page === 'simulate' || route.page === 'case-study' ? 'on' : ''} href={href({ page: 'simulate' })}>Simulate</a>
          <a className={route.page === 'playbook' ? 'on' : ''} href={href({ page: 'playbook' })}>Playbook</a>
        </div>
      </nav>
      {route.page === 'home' && <Home />}
      {route.page === 'learn' && <Learn lessonId={route.lesson} />}
      {route.page === 'simulate' && <Simulate simId={route.sim} variant={route.variant} />}
      {route.page === 'case-study' && <CaseStudy simId={route.sim} />}
      {route.page === 'playbook' && <Playbook docId={route.doc} />}
    </>
  );
}

/** Observe → decide → act → wait, as a ring. */
export function LoopMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="loop-mark">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="12 2.5" />
      <path d="M17.6 4.6 L20.8 5.4 L19.6 8.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}
