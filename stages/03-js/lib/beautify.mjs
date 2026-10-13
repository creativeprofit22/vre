// @ts-check
// Token-based JavaScript re-formatter. Never changes the significant token sequence.
import { tokenize, isIdentChar } from './tokenize.mjs';

export const LIMITS = [
  'Formatting is token-based (no parser): object literals and blocks are both broken after `{`; unary/binary `+`/`-` is guessed from the previous token.',
  'Every line break present in the input is kept (to preserve ASI semantics), so already-formatted code keeps its line structure.',
  'Template literals, strings and regexes are emitted verbatim, including their ${...} expressions.',
  'Comments are kept but re-spaced; no line wrapping of long expressions.',
];

const RESTRICTED = new Set(['return', 'throw', 'break', 'continue', 'yield', 'async']);
const SPACE_KW = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'typeof', 'void', 'delete', 'new',
  'in', 'of', 'instanceof', 'case', 'do', 'else', 'try', 'finally', 'var', 'let', 'const',
  'yield', 'await', 'async', 'function', 'class', 'extends', 'import', 'export', 'from', 'as',
  'with', 'static', 'get', 'set', 'default',
]);
const BIN_KW = new Set(['in', 'of', 'instanceof', 'else', 'catch', 'finally', 'extends', 'from', 'as']);
const VALUE_KW = new Set(['this', 'super', 'true', 'false', 'null', 'undefined']);
const BINOPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=',
  '??=', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '&&', '||', '??', '*', '/', '%', '**',
  '<<', '>>', '>>>', '&', '|', '^', '?', '=>',
]);
const NO_NL_AFTER_CLOSE = new Set(['in', 'of', 'instanceof', 'else', 'catch', 'finally', 'while', 'as']);

/**
 * @param {{type:string,value:string}|null} t
 * @returns {boolean} whether t can end an expression (so a following +/- is binary)
 */
function endsExpr(t) {
  if (!t) return false;
  if (t.type === 'name') return VALUE_KW.has(t.value) || !SPACE_KW.has(t.value);
  if (t.type === 'punct') return t.value === ')' || t.value === ']' || t.value === '}' || t.value === '++' || t.value === '--';
  return t.type !== 'comment' && t.type !== 'hashbang';
}

/**
 * Reformat (minified) JavaScript.
 * @param {string} src
 * @param {{ indent?: string }} [opts]
 * @returns {string}
 */
export function beautify(src, { indent = '  ' } = {}) {
  const all = tokenize(src);
  /** @type {{type:string,value:string,nl:boolean}[]} */
  const toks = [];
  let pendingNl = false;
  for (const t of all) {
    if (t.type === 'ws') {
      if (/[\n\r\u2028\u2029]/.test(t.value)) pendingNl = true;
      continue;
    }
    toks.push({ type: t.type, value: t.value, nl: pendingNl });
    pendingNl = false;
  }

  /** @type {string[]} */
  const out = [];
  /** @type {string[]} bracket stack */
  const stack = [];
  let level = 0;
  let lineStart = true;
  let lastChar = '';
  /** @type {{type:string,value:string}|null} */
  let prevSig = null;
  /** @type {{type:string,value:string}|null} */
  let prevTok = null;
  let prevUnary = false; // previous punct was a prefix unary operator
  let wantNl = false;
  let wantSpace = false;

  /** @param {string} s */
  const write = (s) => {
    if (!s) return;
    out.push(s);
    lastChar = s[s.length - 1];
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const v = t.value;
    const isPunct = t.type === 'punct';
    if (isPunct && (v === '}' || v === ')' || v === ']')) {
      const open = stack.pop();
      if (v === '}' && open === '{') {
        level = Math.max(0, level - 1);
        if (!(prevTok && prevTok.type === 'punct' && prevTok.value === '{')) wantNl = true;
      }
    }

    // Decide separator before this token.
    let nl = wantNl || t.nl;
    if (nl && prevTok && prevTok.type === 'name' && RESTRICTED.has(prevTok.value) && !t.nl) nl = false;
    if (nl && !t.nl && isPunct && (v === '++' || v === '--' || v === '=>')) nl = false;
    if (out.length === 0) nl = false;
    let space = false;
    if (!nl && prevTok) {
      space = wantSpace || needSpace(prevTok, t, prevUnary, prevSig);
      // merge guards
      const first = v.charCodeAt(0);
      if (isIdentChar(lastChar.charCodeAt(0)) && (isIdentChar(first) || first === 35)) space = true;
      if ((lastChar === '+' || lastChar === '-') && v[0] === lastChar) space = true;
      if (lastChar === '/' && (v[0] === '/' || v[0] === '*')) space = true;
      if (prevTok.type === 'number' && (v === '.' || v === '?.') && /^[0-9_]+$/.test(prevTok.value)) space = true;
      if (prevTok.type === 'number' && t.type === 'number') space = true;
      if (lastChar === '<' && v.startsWith('!--')) space = true;
      if (lastChar === '-' && v[0] === '>') space = true;
      if (lastChar === '?' && v[0] === '.' && t.type === 'number') space = true;
    }
    if (nl) {
      write('\n');
      lineStart = true;
    } else if (space && !lineStart) {
      write(' ');
    }
    if (lineStart) {
      if (level > 0) write(indent.repeat(level));
      lineStart = false;
    }
    write(v);
    wantNl = false;
    wantSpace = false;

    // After-token effects.
    if (t.type === 'comment') {
      if (v.startsWith('//')) wantNl = true;
      else wantSpace = true;
    } else if (t.type === 'hashbang') {
      wantNl = true;
    } else if (isPunct) {
      if (v === '{' || v === '(' || v === '[') {
        stack.push(v);
        if (v === '{') {
          level++;
          const next = toks[i + 1];
          if (!(next && next.type === 'punct' && next.value === '}')) wantNl = true;
        }
      } else if (v === ';') {
        if (stack[stack.length - 1] !== '(') wantNl = true;
        else wantSpace = true;
      } else if (v === ',') {
        if (stack[stack.length - 1] === '{') wantNl = true;
        else wantSpace = true;
      } else if (v === '}') {
        const next = toks[i + 1];
        if (next && next.type === 'name' && !NO_NL_AFTER_CLOSE.has(next.value)) wantNl = true;
      }
    }

    if (t.type !== 'comment') {
      prevUnary = isPunct && isUnary(v, prevSig);
      prevSig = t;
    }
    prevTok = t;
  }
  write('\n');
  return out.join('');
}

/**
 * @param {string} v
 * @param {{type:string,value:string}|null} prev
 */
function isUnary(v, prev) {
  if (v === '!' || v === '~') return true;
  if (v === '+' || v === '-' || v === '++' || v === '--') return !endsExpr(prev);
  return false;
}

/**
 * @param {{type:string,value:string}} a previous token
 * @param {{type:string,value:string}} b current token
 * @param {boolean} aUnary
 * @param {{type:string,value:string}|null} prevSig
 */
function needSpace(a, b, aUnary, prevSig) {
  const av = a.value;
  const bv = b.value;
  if (b.type === 'comment') return true;
  if (b.type === 'punct') {
    if (bv === ';' || bv === ',' || bv === ')' || bv === ']' || bv === '.' || bv === '?.') return false;
    if (bv === ':') return false;
    if ((bv === '(' || bv === '[') && a.type === 'punct' && (BINOPS.has(av) || av === ',' || ((av === '+' || av === '-') && !aUnary))) return true;
    if (bv === '(' || bv === '[') return a.type === 'name' && SPACE_KW.has(av) && av !== 'function' && av !== 'import' && av !== 'super';
    if (bv === '{') return !(a.type === 'punct' && (av === '(' || av === '[' || av === '{' || av === '...'));
    if (bv === '}') return !(a.type === 'punct' && av === '{');
    if (BINOPS.has(bv)) return true;
    if (bv === '+' || bv === '-') return endsExpr(prevSig);
    if ((bv === '++' || bv === '--') && endsExpr(prevSig)) return false; // postfix
  }
  if (a.type === 'punct') {
    if (av === '(' || av === '[' || av === '.' || av === '?.' || av === '...' || av === '!' || av === '~') return false;
    if (av === ',' || av === ':' || av === ';') return true;
    if (BINOPS.has(av)) return true;
    if (av === '+' || av === '-' || av === '++' || av === '--') return !aUnary && !(av.length === 2);
    if (av === ')' || av === ']' || av === '}') return b.type === 'name' || b.type === 'punct';
    return false;
  }
  if (a.type === 'name' && SPACE_KW.has(av)) return true;
  if (b.type === 'name' && BIN_KW.has(bv)) return true;
  return false;
}
