import type { SimulationId } from './schema';
import { parseMarkdown, type Doc } from './markdown';

// The case studies live in docs/ so they read well on GitHub too; the site renders the same files.
const FILES = import.meta.glob<string>('../../../docs/case-studies/*.md', { query: '?raw', import: 'default', eager: true });

export const CASE_STUDIES: Partial<Record<SimulationId, Doc>> = Object.fromEntries(
  Object.entries(FILES).map(([path, md]) => [path.replace(/^.*\/|\.md$/g, ''), parseMarkdown(md)]),
);
