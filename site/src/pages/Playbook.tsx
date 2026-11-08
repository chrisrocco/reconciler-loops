import { Blocks } from '../components/Markup';
import { PLAYBOOK } from '../content/playbook';
import { href } from '../router';

/** The implementation playbook, and the notes that apply it to one kind of work. */
export function Playbook({ docId = '' }: { docId?: string }) {
  const entry = PLAYBOOK.find((p) => p.id === docId);
  const notes = PLAYBOOK.filter((p) => p.id !== '');
  if (!entry) return <div className="page"><a className="back" href={href({ page: 'playbook' })}>← The playbook</a><p>No page here.</p></div>;
  const { doc } = entry;
  return (
    <article className="lesson case-study">
      {docId && <a className="back" href={href({ page: 'playbook' })}>← The playbook</a>}
      <div className="lesson-kicker">{docId ? 'Playbook · domain note' : 'Playbook'}</div>
      <h1>{doc.title}</h1>
      <p className="lesson-summary">{doc.summary}</p>
      <div className="prose"><Blocks blocks={doc.blocks} /></div>
      {!docId && notes.map((n) => (
        <a key={n.id} className="sim-cta" href={href({ page: 'playbook', doc: n.id })}>
          <span className="sim-cta-kicker">Domain note</span>
          <span className="sim-cta-title">{n.doc.title} →</span>
          <span className="sim-cta-blurb">{n.doc.summary}</span>
        </a>
      ))}
    </article>
  );
}
