import type { Block } from './schema';

export interface Doc { title: string; summary: string; blocks: Block[] }

/**
 * The Markdown the case studies are written in, as lesson blocks: a `#` title, then its first
 * paragraph as the summary; `##` headings, paragraphs, `-` and `1.` lists, pipe tables,
 * `>` callouts and fenced code. Inline `code` and **bold** are left for <Inline>.
 */
export function parseMarkdown(md: string): Doc {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let title = '';
  let i = 0;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) body.push(lines[i]!);
      blocks.push({ code: body.join('\n') });
      i++;
    } else if (/^# /.test(line)) { title = line.slice(2).trim(); i++; }
    else if (/^#{2,3} /.test(line)) { blocks.push({ h: line.replace(/^#+ /, '').trim() }); i++; }
    else if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith('|'); i++) if (!/^\|[\s:|-]+\|$/.test(lines[i]!.trim())) rows.push(cells(lines[i]!));
      blocks.push({ table: { head: rows[0] ?? [], rows: rows.slice(1) } });
    } else if (/^(- |\d+\. )/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^(- |\d+\. |\s+\S)/.test(lines[i]!); i++) {
        if (/^\s/.test(lines[i]!)) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else items.push(lines[i]!.replace(/^(- |\d+\. )/, ''));
      }
      blocks.push({ list: items, ordered });
    } else if (line.startsWith('>')) {
      const body: string[] = [];
      for (; i < lines.length && lines[i]!.startsWith('>'); i++) body.push(lines[i]!.replace(/^>\s?/, ''));
      blocks.push({ callout: body.join(' ') });
    } else {
      const body: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !/^(#|\||- |\d+\. |>|```)/.test(lines[i]!); i++) body.push(lines[i]!.trim());
      blocks.push({ p: body.join(' ') });
    }
  }
  const first = blocks.findIndex((b) => 'p' in b);
  const summary = first === 0 ? (blocks.shift() as { p: string }).p : '';
  return { title, summary, blocks };
}
