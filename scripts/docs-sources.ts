/**
 * Refresh the code copied into the docs. A `<!-- source: src/path.ts#region -->` line is followed
 * by a fenced block holding that region, so the Markdown reads on GitHub; the site reads the
 * region straight from the file. test/docs-sources.test.ts fails when a copy is stale.
 *
 * Run: npm run docs:sources
 */
import fs from 'node:fs';
import path from 'node:path';
import { extract, parseRef } from '../site/src/content/excerpt.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DOCS = path.join(ROOT, 'docs');

export const readSource = (ref: string) => {
  const { file, region } = parseRef(ref);
  return extract(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), region);
};

/** The doc with every source block's fenced copy replaced by the current code. */
export function syncDoc(md: string): string {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!);
    const m = lines[i]!.match(/^<!-- source: (\S+) -->$/);
    if (!m) continue;
    // Drop the old copy, if there is one, and write the current code.
    let j = i + 1;
    if (lines[j]?.startsWith('```')) { for (j++; j < lines.length && !lines[j]!.startsWith('```'); j++); j++; }
    out.push('```ts', ...readSource(m[1]!).code.split('\n'), '```');
    i = j - 1;
  }
  return out.join(eol);
}

export const docFiles = (dir = DOCS): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? docFiles(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const f of docFiles()) {
    const md = fs.readFileSync(f, 'utf8');
    const next = syncDoc(md);
    if (next !== md) { fs.writeFileSync(f, next); console.log(`updated ${path.relative(ROOT, f)}`); }
  }
}
