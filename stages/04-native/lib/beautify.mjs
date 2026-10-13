// @ts-check
// Zero-dependency re-indenter for minified JS (as extracted from Bun standalone bundles).
// Not a parser: a string/regex/template/comment-aware scanner that inserts newlines after `;` `{` `}`
// (outside parentheses) and indents by brace depth. It only ever inserts whitespace between tokens;
// on anything it cannot balance it returns the original text unchanged.

const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const ID = /[\w$\u0080-\uffff]/;

/**
 * Split JS into tokens. Kinds: str, tpl (template chunk incl. delimiters), re, comment, ws, word, punct.
 * Template literals with `${...}` are emitted as tpl chunks around normal tokens of the expression.
 * Throws on unterminated strings/comments/regexes/templates.
 * @param {string} src
 * @returns {{ kind: string, text: string }[]}
 */
export function tokenize(src) {
  /** @type {{ kind: string, text: string }[]} */
  const out = [];
  /** @type {number[]} brace depth per open template expression (`${`) */
  const tplStack = [];
  let braces = 0;
  let i = 0;
  const n = src.length;
  /** @returns {boolean} whether a `/` here starts a regex */
  const regexAllowed = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k];
      if (t.kind === 'ws' || t.kind === 'comment') continue;
      if (t.kind === 'word') return REGEX_KEYWORDS.has(t.text);
      if (t.kind === 'str' || t.kind === 're') return false;
      if (t.kind === 'tpl') return t.text.endsWith('${');
      return !(t.text === ')' || t.text === ']' || t.text === '}' || t.text === '++' || t.text === '--');
    }
    return true;
  };
  /** scan template body starting at i (just after ` or }); returns end index, chunk ends with ` or ${ */
  const scanTpl = (/** @type {number} */ s) => {
    let j = s;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j + 1;
      if (c === '$' && src[j + 1] === '{') return j + 2;
      j++;
    }
    throw new Error('unterminated template');
  };
  while (i < n) {
    const c = src[i];
    const s = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029' || c === '\ufeff') {
      while (i < n && /[ \t\n\r\u2028\u2029\ufeff]/.test(src[i])) i++;
      out.push({ kind: 'ws', text: src.slice(s, i) });
    } else if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      out.push({ kind: 'comment', text: src.slice(s, i) });
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new Error('unterminated comment');
      i = e + 2;
      out.push({ kind: 'comment', text: src.slice(s, i) });
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\n') throw new Error('newline in string');
        i += src[i] === '\\' ? 2 : 1;
      }
      if (i >= n) throw new Error('unterminated string');
      i++;
      out.push({ kind: 'str', text: src.slice(s, i) });
    } else if (c === '`') {
      i = scanTpl(i + 1);
      out.push({ kind: 'tpl', text: src.slice(s, i) });
      if (src.endsWith('${', i)) tplStack.push(braces);
    } else if (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === braces) {
      tplStack.pop();
      i = scanTpl(i + 1);
      out.push({ kind: 'tpl', text: src.slice(s, i) });
      if (src.endsWith('${', i)) tplStack.push(braces);
    } else if (c === '/' && regexAllowed()) {
      i++;
      let cls = false;
      while (i < n) {
        const d = src[i];
        if (d === '\n') throw new Error('newline in regex');
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
        i++;
      }
      if (i >= n) throw new Error('unterminated regex');
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      out.push({ kind: 're', text: src.slice(s, i) });
    } else if (ID.test(c)) {
      while (i < n && ID.test(src[i])) i++;
      out.push({ kind: 'word', text: src.slice(s, i) });
    } else {
      const two = src.slice(i, i + 2);
      i += two === '++' || two === '--' ? 2 : 1;
      if (c === '{') braces++;
      else if (c === '}') braces--;
      out.push({ kind: 'punct', text: src.slice(s, i) });
    }
  }
  if (tplStack.length) throw new Error('unterminated template expression');
  return out;
}

/**
 * Re-indent minified JS. Returns the original text if it cannot be tokenized or braces don't balance.
 * @param {string} src
 * @param {{ indent?: string }} [opts]
 * @returns {{ code: string, ok: boolean, error?: string }}
 */
export function beautify(src, opts = {}) {
  const ind = opts.indent ?? '  ';
  try {
    const toks = tokenize(src);
    /** @type {string[]} */
    const parts = [];
    let depth = 0, parens = 0;
    /** @type {number[]} paren depth saved at each open brace (a block resets it) */
    const saved = [];
    let lineStart = true;
    const nl = () => {
      // trim trailing spaces of current line, then newline + indentation
      while (parts.length && /^[ \t]+$/.test(parts[parts.length - 1])) parts.pop();
      if (!lineStart) parts.push('\n');
      lineStart = true;
    };
    const emit = (/** @type {string} */ t) => {
      if (lineStart) { parts.push(ind.repeat(Math.max(depth, 0))); lineStart = false; }
      parts.push(t);
    };
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.kind === 'ws') {
        if (t.text.includes('\n')) nl(); else if (!lineStart) parts.push(t.text);
        continue;
      }
      if (t.kind === 'comment') { emit(t.text); if (t.text.startsWith('//')) nl(); continue; }
      if (t.kind !== 'punct') { emit(t.text); continue; }
      const p = t.text;
      if (p === '(' || p === '[') { parens++; emit(p); continue; }
      if (p === ')' || p === ']') { parens = Math.max(0, parens - 1); emit(p); continue; }
      if (p === '{') { emit(p); depth++; saved.push(parens); parens = 0; nl(); continue; }
      if (p === '}') {
        depth--;
        parens = saved.pop() ?? 0;
        if (depth < 0) throw new Error('unbalanced }');
        nl(); emit(p);
        let j = k + 1;
        while (j < toks.length && toks[j].kind === 'ws') j++;
        const next = toks[j];
        if (!next || !(next.kind === 'punct' && /^[;,).\]:?]$/.test(next.text))) nl();
        continue;
      }
      if (p === ';' && parens === 0) { emit(p); nl(); continue; }
      emit(p);
    }
    if (depth !== 0) throw new Error(`unbalanced braces (depth ${depth})`);
    while (parts.length && /^[ \t]+$/.test(parts[parts.length - 1])) parts.pop();
    let code = parts.join('');
    if (!code.endsWith('\n')) code += '\n';
    if (code.replace(/\s+/g, '') !== src.replace(/\s+/g, '')) throw new Error('non-whitespace content changed');
    return { code, ok: true };
  } catch (e) {
    return { code: src, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Short guess of what a module is: `//#region` paths, a meaningful path, or imported specifiers and notable strings.
 * @param {string} relPath module path inside the bundle
 * @param {string} [src] JS source (omit for non-JS)
 * @returns {string}
 */
export function guessModule(relPath, src) {
  const ext = (/\.([^./]+)$/.exec(relPath)?.[1] ?? '').toLowerCase();
  const known = /** @type {Record<string, string>} */ ({ wasm: 'WebAssembly module', node: 'Node native addon', dll: 'native DLL',
    wav: 'audio clip', scm: 'tree-sitter query', json: 'JSON data', map: 'source map' });
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(relPath)?.[1];
  if (src == null || !/^(m?js|cjs|ts|tsx|jsx)$/.test(ext)) {
    const base = known[ext] ?? (ext ? `${ext} file` : 'file');
    return /tree-sitter-([\w-]+?)-[a-z0-9]{8}\.wasm$/.test(relPath) ? `${base}: tree-sitter ${/tree-sitter-([\w-]+?)-[a-z0-9]{8}\.wasm$/.exec(relPath)?.[1]} grammar` : base;
  }
  const regions = [...new Set([...src.matchAll(/\/\/#region (\S+)/g)].map((m) => m[1]))];
  if (regions.length) {
    const pkgs = [...new Set(regions.map((r) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(r)?.[1] ?? r.split('/').slice(0, 2).join('/')))];
    return `regions (${regions.length}): ${pkgs.slice(0, 5).join(', ')}${pkgs.length > 5 ? ', ...' : ''}`;
  }
  if (nm) return `package ${nm}`;
  /** @type {string[]} */
  const bits = [];
  if (!/(^|\/)chunk-[a-z0-9]+\.js$/.test(relPath)) bits.push(`source ${relPath}`);
  const specs = [...new Set([...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?|\brequire\()\s*["']((?:node:)?@?[\w-]+(?:\/[\w.-]+)*)["']/g)].map((m) => m[1]))].sort();
  if (specs.length) bits.push(`imports ${specs.slice(0, 6).join(', ')}${specs.length > 6 ? ', ...' : ''}`);
  const urls = [...new Set([...src.matchAll(/https?:\/\/[\w.-]+/g)].map((m) => m[0]))].sort();
  if (urls.length) bits.push(`urls ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? ', ...' : ''}`);
  const ids = [...new Set([...src.matchAll(/\b(?:class|function)\s+([A-Za-z_$][\w$]{5,})/g)].map((m) => m[1]).filter((s) => s !== 'extends'))];
  if (ids.length) bits.push(`defines ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', ...' : ''}`);
  return bits.join('; ') || 'bundle chunk (no names found)';
}
