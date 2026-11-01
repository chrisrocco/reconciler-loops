import { useMemo, type CSSProperties } from 'react';
import { githubUrl, type Excerpt } from '../content/excerpt';
import { source } from '../content/sources';
import { highlight, type Token } from './highlight';

/**
 * Highlighted TypeScript, one block per line. A long line wraps instead of scrolling, and its
 * continuation is indented past the line's own indentation, so the structure stays readable.
 */
export function Highlighted({ code }: { code: string }) {
  const lines = useMemo(() => {
    const out: Token[][] = [[]];
    for (const t of highlight(code)) {
      t.text.split('\n').forEach((part, i) => {
        if (i > 0) out.push([]);
        if (part) out[out.length - 1]!.push({ ...t, text: part });
      });
    }
    return out;
  }, [code]);
  return (
    <code>
      {lines.map((line, n) => {
        const indent = (line[0]?.text.match(/^ */)?.[0].length ?? 0) + 4;
        return (
          <span key={n} className="ln" style={{ '--hang': `${indent}ch` } as CSSProperties}>
            {line.length ? line.map((t, i) => (t.cls ? <span key={i} className={`tk-${t.cls}`}>{t.text}</span> : t.text)) : ' '}
          </span>
        );
      })}
    </code>
  );
}

/** A short sketch of real code, labeled as simplified, linking to the code it simplifies. */
export function SketchBlock({ code, from }: { code: string; from: string }) {
  let x: Excerpt | undefined;
  try { x = source(from); } catch { /* the link is a convenience; the test checks it */ }
  return (
    <figure className="source">
      <figcaption className="source-head">
        <span>Simplified from <span className="source-file">{x?.file ?? from}</span></span>
        {x && <a className="source-link" href={githubUrl(x)} target="_blank" rel="noreferrer">See the real code ↗</a>}
      </figcaption>
      <pre className="code-block"><Highlighted code={code} /></pre>
    </figure>
  );
}

/** A real excerpt of the repository, labeled with its file and lines, linking to it on GitHub. */
export function SourceBlock({ refName, caption }: { refName: string; caption?: string }) {
  let x: Excerpt;
  try { x = source(refName); } catch (e) { return <div className="callout warn">Missing source: {String(e)}</div>; }
  return (
    <figure className="source">
      <figcaption className="source-head">
        <span className="source-file">{x.file}</span>
        <span className="source-lines">lines {x.startLine}–{x.endLine}</span>
        <a className="source-link" href={githubUrl(x)} target="_blank" rel="noreferrer">View on GitHub ↗</a>
      </figcaption>
      <pre className="code-block"><Highlighted code={x.code} /></pre>
      {caption && <div className="source-caption">{caption}</div>}
    </figure>
  );
}
