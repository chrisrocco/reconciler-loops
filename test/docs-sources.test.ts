/** The code shown in the docs and on the site is the code in the repository. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { docFiles, readSource, syncDoc } from '../scripts/docs-sources.js';

test('every source block in docs/ matches the code it names (npm run docs:sources refreshes them)', () => {
  for (const f of docFiles()) {
    const md = fs.readFileSync(f, 'utf8');
    assert.equal(md, syncDoc(md), `${path.basename(f)} has a stale code copy`);
  }
});

test('every source the lessons name exists', () => {
  const lessons = fs.readFileSync(path.join(import.meta.dirname, '../site/src/content/lessons.ts'), 'utf8');
  const refs = [...lessons.matchAll(/(?:source|from): '([^']+)'/g)].map((m) => m[1]!);
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.doesNotThrow(() => readSource(ref), ref);
});
