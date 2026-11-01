/**
 * Excerpts of the repository's own code, so the code on the site is the code that runs.
 *
 * A reference is a file path from the repository root, optionally with a region:
 * `src/scenarios/migration.ts#campaign-plan` is the code between `// #region campaign-plan`
 * and the next `// #endregion` in that file. Without a region, it is the whole file.
 * Marker lines are dropped and the excerpt is dedented.
 */
export interface Excerpt { file: string; region?: string; code: string; startLine: number; endLine: number }

export const REPO_URL = 'https://github.com/chrisrocco/reconciler-loops';

const MARKER = /^\s*\/\/ #(end)?region\b/;

export function extract(file: string, text: string, region?: string): Excerpt {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let from = 0, to = lines.length;
  if (region) {
    from = lines.findIndex((l) => l.trim() === `// #region ${region}`) + 1;
    if (from === 0) throw new Error(`no region "${region}" in ${file}`);
    // Regions nest: a small region can sit inside a bigger one.
    let depth = 1;
    to = lines.findIndex((l, i) => i >= from && (/^\s*\/\/ #region\b/.test(l) ? (depth++, false) : /^\s*\/\/ #endregion\b/.test(l) && --depth === 0));
    if (to < 0) throw new Error(`region "${region}" in ${file} has no #endregion`);
  }
  const body = lines.slice(from, to).filter((l) => !MARKER.test(l));
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return { file, region, code: body.map((l) => l.slice(indent)).join('\n'), startLine: from + 1, endLine: to };
}

export function parseRef(ref: string) {
  const [file, region] = ref.split('#') as [string, string | undefined];
  return { file, region };
}

export const githubUrl = (x: Excerpt) => `${REPO_URL}/blob/main/${x.file}#L${x.startLine}-L${x.endLine}`;
