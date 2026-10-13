// @ts-check
// Pure helpers: rolldown `//#region` splitting, safe path normalization,
// comment stripping, import extraction and file classification.

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Make one path segment safe on Windows and POSIX.
 * @param {string} seg
 */
export function sanitizeSegment(seg) {
  // eslint-disable-next-line no-control-regex
  let s = seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

/**
 * Normalize an original module path from a region marker into a safe relative path.
 * Leading `../` segments are stripped, `\0` becomes `_virtual/`, inner `..` that would
 * escape the folder makes the path rejected (null).
 * @param {string} p
 * @returns {string|null}
 */
export function normalizeRegionPath(p) {
  if (typeof p !== 'string') return null;
  let s = p.trim();
  let virtual = false;
  // real NUL byte, or the literal two-char text `\0` that rolldown prints in markers
  if (s.includes('\0') || s.startsWith('\\0')) { virtual = true; s = s.replace(/\0/g, '').replace(/^\\0/, ''); }
  s = s.replace(/\\/g, '/');
  s = s.replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
  const raw = s.split('/');
  const out = [];
  let leading = true;
  for (const seg of raw) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (leading) continue;
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    leading = false;
    out.push(sanitizeSegment(seg));
  }
  if (out.length === 0) return null;
  if (virtual) out.unshift('_virtual');
  return out.join('/');
}

/**
 * Split a rolldown bundle into its `//#region <path>` blocks.
 * Nested/unterminated regions: a new `//#region` closes the open one.
 * @param {string} src
 * @returns {{ regions: {path: string, code: string}[], unregioned: string }}
 */
export function splitRegions(src) {
  /** @type {{path: string, code: string}[]} */
  const regions = [];
  /** @type {string[]} */
  const outside = [];
  let pos = 0;
  /** @type {{path: string, start: number}|null} */
  let open = null;
  let outsideStart = 0;
  while (pos < src.length) {
    let nl = src.indexOf('\n', pos);
    if (nl === -1) nl = src.length;
    const line = src.slice(pos, nl).replace(/\r$/, '');
    if (line.startsWith('//#region ') || line === '//#endregion' || line.startsWith('//#endregion ')) {
      if (open) regions.push({ path: open.path, code: src.slice(open.start, pos) });
      else outside.push(src.slice(outsideStart, pos));
      if (line.startsWith('//#region ')) {
        open = { path: line.slice(10).trim(), start: nl + 1 };
      } else {
        open = null;
        outsideStart = nl + 1;
      }
    }
    pos = nl + 1;
  }
  if (open) regions.push({ path: open.path, code: src.slice(Math.min(open.start, src.length)) });
  else if (outsideStart < src.length) outside.push(src.slice(outsideStart));
  return { regions, unregioned: outside.join('') };
}

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * Replace comments with spaces (newlines kept, so offsets are preserved).
 * Strings, template literals and (heuristically) regex literals are left intact.
 * @param {string} src
 */
export function stripComments(src) {
  const out = [];
  let last = 0;
  let i = 0;
  let prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        else if (c !== '`' && src[i] === '\n') break;
        i++;
      }
      i++; prev = 'a'; continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let e = src.indexOf('\n', i); if (e === -1) e = n;
      out.push(src.slice(last, i), ' '.repeat(e - i)); last = i = e; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2); e = e === -1 ? n : e + 2;
      out.push(src.slice(last, i), src.slice(i, e).replace(/[^\n]/g, ' ')); last = i = e; continue;
    }
    if (c === '/' && REGEX_PREV.has(prev)) {
      i++;
      let cls = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        else if (src[i] === '/' && !cls) break;
        i++;
      }
      i++; prev = 'a'; continue;
    }
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? 'a' : c;
    i++;
  }
  if (last === 0) return src;
  out.push(src.slice(last));
  return out.join('');
}

const IMPORT_RES = [
  /\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'\n]+)["']/g,
  /\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/**
 * Static/dynamic import specifiers, sorted and unique. Pass comment-stripped code for best results.
 * @param {string} code
 * @returns {string[]}
 */
export function extractImports(code) {
  const set = new Set();
  for (const re of IMPORT_RES) for (const m of code.matchAll(re)) set.add(m[1]);
  return [...set].sort();
}

/** @param {string} src */
export function avgLineLength(src) {
  if (!src.length) return 0;
  let lines = 1;
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) lines++;
  return src.length / lines;
}

/** @param {string} src */
export const isMinified = (src) => avgLineLength(src) > 300;

/** @param {string} relPath posix path inside archive */
export const isThirdParty = (relPath) => /(^|\/)node_modules\//.test(relPath);

/** @param {string} relPath */
export const isJsFile = (relPath) => /\.(c|m)?js$/i.test(relPath);

/**
 * @param {string} relPath posix path inside the archive
 * @param {{ regions: number }} info
 * @returns {'node-bundle'|'browser-chunk'|'preload'|'other'}
 */
export function classify(relPath, { regions }) {
  if (isThirdParty(relPath)) return 'other';
  const base = relPath.split('/').pop() ?? '';
  if (/(^|\/)(client|assets|renderer|public)\//.test(relPath) && /\.js$/i.test(base)) return 'browser-chunk';
  if (/preload/i.test(base)) return 'preload';
  if (regions > 0 || /\.(c|m)js$/i.test(base)) return 'node-bundle';
  return 'other';
}
