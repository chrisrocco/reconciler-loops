/** A small TypeScript highlighter: comments, strings, keywords, numbers, types and calls. Enough for reading, not a parser. */
export type Token = { text: string; cls?: 'com' | 'str' | 'kw' | 'num' | 'type' | 'fn' };

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export', 'extends',
  'false', 'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let', 'new', 'null', 'of',
  'readonly', 'return', 'satisfies', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'as', 'keyof', 'never',
]);

const RULES: [RegExp, Token['cls'] | 'word'][] = [
  [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, 'com'],
  [/`(?:\\[\s\S]|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y, 'str'],
  [/\b\d[\d_]*(?:\.\d+)?\b/y, 'num'],
  [/[A-Za-z_$][\w$]*/y, 'word'],
];

export function highlight(code: string): Token[] {
  const out: Token[] = [];
  const push = (text: string, cls?: Token['cls']) => {
    const last = out[out.length - 1];
    if (!cls && last && !last.cls) last.text += text;
    else out.push({ text, cls });
  };
  let i = 0;
  outer: while (i < code.length) {
    for (const [re, kind] of RULES) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m) continue;
      const text = m[0];
      if (kind === 'word') {
        const next = code.slice(i + text.length).match(/^\s*(\(|<[\w\s,<>[\]|'.]*>\s*\()/);
        push(text, KEYWORDS.has(text) ? 'kw' : /^[A-Z]/.test(text) ? 'type' : next ? 'fn' : undefined);
      } else push(text, kind);
      i += text.length;
      continue outer;
    }
    push(code[i]!);
    i++;
  }
  return out;
}
