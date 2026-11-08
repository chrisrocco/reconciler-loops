import { parseMarkdown, type Doc } from './markdown';

// The playbook lives in docs/playbook/ so an agent can read it as a plain file; the site renders the same files.
const FILES = import.meta.glob<string>('../../../docs/playbook/*.md', { query: '?raw', import: 'default', eager: true });

/** The playbook first (README.md, id ''), then the domain notes. */
export const PLAYBOOK: { id: string; doc: Doc }[] = Object.entries(FILES)
  .map(([path, md]) => ({ id: path.replace(/^.*\/|\.md$/g, '').replace(/^README$/, ''), doc: parseMarkdown(md) }))
  .sort((a, b) => (a.id === '' ? -1 : b.id === '' ? 1 : a.id.localeCompare(b.id)));
