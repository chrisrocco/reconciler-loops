import type { ReactNode } from 'react';
import type { Block } from '../content/schema';
import { Highlighted, SketchBlock, SourceBlock } from './Code';
import { href } from '../router';

/** Inline text: `code`, **bold** and [links](url), nothing else. */
export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const to = siteHref(link[2]!);
      out.push(<a key={m.index} href={to} {...(to.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })}><Inline text={link[1]!} /></a>);
    } else out.push(tok.startsWith('`') ? <code key={m.index}>{tok.slice(1, -1)}</code> : <strong key={m.index}>{tok.slice(2, -2)}</strong>);
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/**
 * Docs link to the repository by full URL, so the links work on GitHub and in a copy saved into
 * another project. On the site, a link to a doc the site renders stays on the site.
 */
function siteHref(url: string): string {
  const doc = url.match(/^https:\/\/github\.com\/chrisrocco\/reconciler-loops\/blob\/main\/docs\/(playbook|case-studies)\/([\w-]+)\.md$/);
  if (!doc) return url;
  if (doc[1] === 'case-studies') return href({ page: 'case-study', sim: doc[2]! });
  return href({ page: 'playbook', doc: doc[2] === 'README' ? undefined : doc[2] });
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if ('p' in b) return <p key={i}><Inline text={b.p} /></p>;
        if ('h' in b) return <h3 key={i}><Inline text={b.h} /></h3>;
        if ('list' in b) {
          const items = b.list.map((x, j) => <li key={j}><Inline text={x} /></li>);
          return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        if ('source' in b) return <SourceBlock key={i} refName={b.source} caption={b.caption} />;
        if ('code' in b && b.from) return <SketchBlock key={i} code={b.code} from={b.from} />;
        if ('code' in b) return <pre key={i} className="code-block">{b.lang === 'ts' ? <Highlighted code={b.code} /> : <code className="plain">{b.code}</code>}</pre>;
        if ('table' in b)
          return (
            <div key={i} className="table-wrap">
              <table>
                <thead><tr>{b.table.head.map((h, j) => <th key={j}><Inline text={h} /></th>)}</tr></thead>
                <tbody>{b.table.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline text={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        return <div key={i} className={`callout ${b.tone ?? 'note'}`}><Inline text={b.callout} /></div>;
      })}
    </>
  );
}
