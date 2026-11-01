import { extract, parseRef, type Excerpt } from './excerpt';

// The repository's TypeScript, as text, bundled at build time. Paths are keyed from the repo root.
const FILES = import.meta.glob<string>(['../../../src/**/*.ts', '../../../examples/*.ts', '../../../test/*.ts'], { query: '?raw', import: 'default', eager: true });
const BY_PATH = new Map(Object.entries(FILES).map(([p, text]) => [p.replace(/^(\.\.\/)+/, ''), text]));

/** The excerpt a reference names, e.g. `src/scenarios/migration.ts#campaign-plan`. */
export function source(ref: string): Excerpt {
  const { file, region } = parseRef(ref);
  const text = BY_PATH.get(file);
  if (text === undefined) throw new Error(`no file ${file}`);
  return extract(file, text, region);
}
