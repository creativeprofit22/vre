// @ts-check
// Lossless, linear-time JavaScript tokenizer (no JSX / TypeScript).

/** @typedef {{ type: 'ws'|'comment'|'string'|'template'|'regex'|'number'|'name'|'punct'|'hashbang', value: string, start: number, end: number }} Token */

export const LIMITS = [
  'Regex vs division uses the previous significant token: after `)` a slash is division (wrong for `if (x) /re/.test(s)`), after `}` it is a regex (wrong for `({}) / 2`-style object-literal division).',
  'A template literal including its ${...} expressions is a single token.',
  'Unterminated strings, comments, templates or regexes are consumed up to end of input (or line end for regex, falling back to `/` punct).',
  'No JSX / TypeScript / HTML-like comment (<!-- -->) support.',
];

const PUNCTS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '**', '<<', '>>',
];

/** Keywords after which a `/` starts a regex. */
export const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'await',
]);

/** @param {number} c */
function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 ||
    c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

/** @param {number} c */
function isLineTerm(c) {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/** @param {number} c */
export function isIdentChar(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 ||
    c === 95 || c === 92 || (c >= 128 && !isWs(c));
}

/** @param {number} c */
function isDigit(c) {
  return c >= 48 && c <= 57;
}

/**
 * @param {Token|null} prev previous significant token
 * @returns {boolean} whether a `/` here starts a regex
 */
function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === 'punct') {
    const v = prev.value;
    return !(v === ')' || v === ']' || v === '++' || v === '--');
  }
  if (prev.type === 'name') return REGEX_AFTER_KEYWORDS.has(prev.value);
  return false;
}

/**
 * Lex tokens from `pos`. In nested mode (template `${`), stops after the `}` that closes depth 0
 * and returns the position after it.
 * @param {string} src
 * @param {number} pos
 * @param {Token[]} out
 * @param {boolean} nested
 * @returns {number}
 */
function lex(src, pos, out, nested) {
  const n = src.length;
  /** @type {Token|null} */
  let prev = null;
  let depth = 0;
  /** @param {string} type @param {number} s @param {number} e */
  const push = (type, s, e) => {
    const t = /** @type {Token} */ ({ type, value: src.slice(s, e), start: s, end: e });
    out.push(t);
    if (type !== 'ws' && type !== 'comment') prev = t;
  };
  if (!nested && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
    let e = 2;
    while (e < n && !isLineTerm(src.charCodeAt(e))) e++;
    push('hashbang', 0, e);
    pos = e;
  }
  while (pos < n) {
    const c = src.charCodeAt(pos);
    const s = pos;
    if (isWs(c)) {
      pos++;
      while (pos < n && isWs(src.charCodeAt(pos))) pos++;
      push('ws', s, pos);
      continue;
    }
    if (c === 47) { // '/'
      const c2 = src.charCodeAt(pos + 1);
      if (c2 === 47) {
        pos += 2;
        while (pos < n && !isLineTerm(src.charCodeAt(pos))) pos++;
        push('comment', s, pos);
        continue;
      }
      if (c2 === 42) {
        const e = src.indexOf('*/', pos + 2);
        pos = e < 0 ? n : e + 2;
        push('comment', s, pos);
        continue;
      }
      if (regexAllowed(prev)) {
        let p = pos + 1;
        let inClass = false;
        let ok = false;
        while (p < n) {
          const d = src.charCodeAt(p);
          if (isLineTerm(d)) break;
          if (d === 92) { p += 2; continue; }
          if (d === 91) inClass = true;
          else if (d === 93) inClass = false;
          else if (d === 47 && !inClass) { ok = true; p++; break; }
          p++;
        }
        if (ok) {
          while (p < n && isIdentChar(src.charCodeAt(p))) p++;
          pos = p;
          push('regex', s, pos);
          continue;
        }
      }
      pos += src.charCodeAt(pos + 1) === 61 ? 2 : 1;
      push('punct', s, pos);
      continue;
    }
    if (c === 34 || c === 39) {
      pos++;
      while (pos < n) {
        const d = src.charCodeAt(pos);
        if (d === 92) {
          pos += src.charCodeAt(pos + 1) === 13 && src.charCodeAt(pos + 2) === 10 ? 3 : 2;
          continue;
        }
        pos++;
        if (d === c || d === 10 || d === 13) break;
      }
      if (pos > n) pos = n;
      push('string', s, pos);
      continue;
    }
    if (c === 96) {
      pos = scanTemplate(src, pos);
      push('template', s, pos);
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(pos + 1)))) {
      pos = scanNumber(src, pos);
      push('number', s, pos);
      continue;
    }
    if (isIdentChar(c) || c === 35) {
      pos++;
      while (pos < n) {
        const d = src.charCodeAt(pos);
        if (d === 92) { pos += 2; continue; } // \uXXXX escape: rest is ident chars
        if (!isIdentChar(d)) break;
        pos++;
      }
      if (pos > n) pos = n;
      push('name', s, pos);
      continue;
    }
    // punctuator
    let len = 1;
    for (const p of PUNCTS) {
      if (src.startsWith(p, pos)) {
        if (p === '?.' && isDigit(src.charCodeAt(pos + 2))) continue;
        len = p.length;
        break;
      }
    }
    if (c === 123) depth++;
    else if (c === 125) {
      if (nested && depth === 0) {
        push('punct', s, pos + 1);
        return pos + 1;
      }
      depth--;
    }
    pos += len;
    push('punct', s, pos);
  }
  return pos;
}

/** @param {string} src @param {number} pos at the backtick @returns {number} end */
function scanTemplate(src, pos) {
  const n = src.length;
  pos++;
  while (pos < n) {
    const d = src.charCodeAt(pos);
    if (d === 92) { pos += 2; continue; }
    if (d === 96) return pos + 1;
    if (d === 36 && src.charCodeAt(pos + 1) === 123) {
      pos = lex(src, pos + 2, [], true);
      continue;
    }
    pos++;
  }
  return n;
}

/** @param {string} src @param {number} pos @returns {number} end */
function scanNumber(src, pos) {
  const n = src.length;
  const c = src.charCodeAt(pos);
  const c2 = src.charCodeAt(pos + 1) | 32;
  if (c === 48 && (c2 === 120 || c2 === 111 || c2 === 98)) {
    pos += 2;
    while (pos < n) {
      const d = src.charCodeAt(pos);
      const l = d | 32;
      if (isDigit(d) || (l >= 97 && l <= 102) || d === 95) pos++;
      else break;
    }
  } else {
    while (pos < n && (isDigit(src.charCodeAt(pos)) || src.charCodeAt(pos) === 95)) pos++;
    if (src.charCodeAt(pos) === 46) {
      pos++;
      while (pos < n && (isDigit(src.charCodeAt(pos)) || src.charCodeAt(pos) === 95)) pos++;
    }
    if ((src.charCodeAt(pos) | 32) === 101) {
      let p = pos + 1;
      if (src.charCodeAt(p) === 43 || src.charCodeAt(p) === 45) p++;
      if (isDigit(src.charCodeAt(p))) {
        pos = p;
        while (pos < n && (isDigit(src.charCodeAt(pos)) || src.charCodeAt(pos) === 95)) pos++;
      }
    }
  }
  if (src.charCodeAt(pos) === 110) pos++; // BigInt suffix
  return pos;
}

/**
 * Tokenize JavaScript source. Concatenating all token values reproduces `src` exactly.
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  /** @type {Token[]} */
  const out = [];
  lex(src, 0, out, false);
  return out;
}
