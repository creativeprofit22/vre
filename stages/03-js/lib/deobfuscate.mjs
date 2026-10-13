// @ts-check
// Token-based, best-effort, meaning-preserving JavaScript clean-ups plus obfuscation signals.
import { tokenize, isIdentChar } from './tokenize.mjs';

export const LIMITS = [
  'Best effort only: token-level rewrites, no scope analysis; output never proves original source.',
  '`void 0` -> `undefined` is skipped for the whole file if `undefined` looks declared or assigned anywhere.',
  'Rewrites are skipped when followed by `.`, `?.`, `[`, `(` or a template (member/call binds tighter than unary).',
  'Only \\xNN and \\uNNNN string escapes are decoded (not \\u{...}), and only in quoted strings, not templates.',
  'String-array / rotate-IIFE detection is a heuristic (>= 50 string elements; push/shift near each other).',
  'Embedded blobs: only plain string/template literals (optionally data: URLs) of >= 4096 base64 chars.',
];

/** @typedef {{ start: number, end: number, length: number, kind: string }} Embedded */

const MEMBER_NEXT = new Set(['.', '?.', '[', '(']);
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * @param {string} src
 * @returns {{ code: string, changes: Record<string, number>, signals: {
 *   obfuscatorIdentifiers: number, uniqueObfuscatorIdentifiers: number,
 *   stringArray: boolean, largestStringArray: number, rotateIIFE: boolean,
 *   eval: number, newFunction: number, functionCall: number, embedded: Embedded[] } }}
 */
export function deobfuscate(src) {
  const toks = tokenize(src);
  /** @type {number[]} indices of significant tokens */
  const sig = [];
  for (let i = 0; i < toks.length; i++) {
    const ty = toks[i].type;
    if (ty !== 'ws' && ty !== 'comment') sig.push(i);
  }
  const changes = { notZeroToTrue: 0, notOneToFalse: 0, voidZeroToUndefined: 0, numberToDecimal: 0, stringEscapesDecoded: 0 };

  // Is `undefined` possibly shadowed?
  let undefinedUnsafe = false;
  for (let k = 0; k < sig.length; k++) {
    const t = toks[sig[k]];
    if (t.type !== 'name' || t.value !== 'undefined') continue;
    const p = k > 0 ? toks[sig[k - 1]] : null;
    const nx = k + 1 < sig.length ? toks[sig[k + 1]] : null;
    if (p && /^(var|let|const|function|class|catch)$/.test(p.value)) undefinedUnsafe = true;
    if (nx && nx.type === 'punct' && /^(=|[-+*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=|\+\+|--)$/.test(nx.value)) undefinedUnsafe = true;
    if (p && p.type === 'punct' && (p.value === '++' || p.value === '--')) undefinedUnsafe = true;
  }

  /** @type {Map<number, {to: number, text: string}>} token index -> replacement up to (excl) token index */
  const repl = new Map();
  /** @param {number} k */
  const nextIsMember = (k) => {
    const nx = k < sig.length ? toks[sig[k]] : null;
    return !!nx && ((nx.type === 'punct' && MEMBER_NEXT.has(nx.value)) || nx.type === 'template');
  };

  for (let k = 0; k < sig.length; k++) {
    const i = sig[k];
    const t = toks[i];
    if (t.type === 'punct' && t.value === '!' && k + 1 < sig.length) {
      const nt = toks[sig[k + 1]];
      const prev = k > 0 ? toks[sig[k - 1]] : null;
      const prevMember = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');
      if (nt.type === 'number' && (nt.value === '0' || nt.value === '1') && !nextIsMember(k + 2) && !prevMember &&
          !(k + 2 < sig.length && toks[sig[k + 2]].value === '**')) {
        repl.set(i, { to: sig[k + 1] + 1, text: nt.value === '0' ? 'true' : 'false' });
        changes[nt.value === '0' ? 'notZeroToTrue' : 'notOneToFalse']++;
        k++;
        continue;
      }
    }
    if (!undefinedUnsafe && t.type === 'name' && t.value === 'void' && k + 1 < sig.length) {
      const nt = toks[sig[k + 1]];
      const prev = k > 0 ? toks[sig[k - 1]] : null;
      const prevMember = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');
      if (nt.type === 'number' && nt.value === '0' && !nextIsMember(k + 2) && !prevMember &&
          !(k + 2 < sig.length && toks[sig[k + 2]].value === '**')) {
        repl.set(i, { to: sig[k + 1] + 1, text: 'undefined' });
        changes.voidZeroToUndefined++;
        k++;
        continue;
      }
    }
    if (t.type === 'number' && /^0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+|[0-7]+)$/.test(t.value)) {
      const nx = k + 1 < sig.length ? toks[sig[k + 1]] : null;
      if (nx && nx.type === 'punct' && (nx.value === '.' || nx.value === '?.')) continue;
      const v = /^0[0-7]+$/.test(t.value) ? parseInt(t.value.slice(1), 8) : Number(t.value);
      if (!Number.isSafeInteger(v)) continue;
      const text = String(v);
      if (!/^[0-9]+$/.test(text)) continue;
      repl.set(i, { to: i + 1, text });
      changes.numberToDecimal++;
      continue;
    }
    if (t.type === 'string' && t.value.includes('\\')) {
      const r = decodeEscapes(t.value);
      if (r.count > 0) {
        repl.set(i, { to: i + 1, text: r.text });
        changes.stringEscapesDecoded += r.count;
      }
    }
  }

  // Emit, guarding against tokens merging with neighbours.
  /** @type {string[]} */
  const out = [];
  let last = '';
  for (let i = 0; i < toks.length; i++) {
    const r = repl.get(i);
    if (!r) {
      const v = toks[i].value;
      out.push(v);
      last = v;
      continue;
    }
    let text = r.text;
    if (last && isIdentChar(last.charCodeAt(last.length - 1)) && isIdentChar(text.charCodeAt(0))) text = ' ' + text;
    const after = r.to < toks.length ? toks[r.to].value : '';
    if (after && isIdentChar(text.charCodeAt(text.length - 1)) && (isIdentChar(after.charCodeAt(0)) || after[0] === '#')) text += ' ';
    if (after && after[0] === '.' && /[0-9]$/.test(text)) text += ' ';
    out.push(text);
    last = text;
    i = r.to - 1;
  }

  // Signals.
  let obfIds = 0;
  const uniqueObf = new Set();
  let largestStringArray = 0;
  let evalCount = 0;
  let newFunction = 0;
  let functionCall = 0;
  let lastPush = -1e9;
  let lastShift = -1e9;
  let rotateIIFE = false;
  /** @type {Embedded[]} */
  const embedded = [];
  for (let k = 0; k < sig.length; k++) {
    const t = toks[sig[k]];
    const prev = k > 0 ? toks[sig[k - 1]] : null;
    const nx = k + 1 < sig.length ? toks[sig[k + 1]] : null;
    const prevDot = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');
    if (t.type === 'name') {
      if (/^_0x[0-9a-f]+$/i.test(t.value)) { obfIds++; uniqueObf.add(t.value); }
      if (t.value === 'eval' && !prevDot && nx && nx.value === '(') evalCount++;
      if (t.value === 'Function' && !prevDot) {
        if (prev && prev.value === 'new') newFunction++;
        else if (nx && nx.value === '(') functionCall++;
      }
      if (prevDot && t.value === 'push') lastPush = k;
      if (prevDot && t.value === 'shift') lastShift = k;
    } else if (t.type === 'string') {
      const inner = t.value.slice(1, -1);
      if (inner === 'push') lastPush = k;
      if (inner === 'shift') lastShift = k;
      if (t.value.length >= 4098) detectEmbedded(src, t.start + 1, t.end - 1, embedded);
    } else if (t.type === 'template') {
      if (t.value.length >= 4098 && !t.value.includes('${')) detectEmbedded(src, t.start + 1, t.end - 1, embedded);
    } else if (t.type === 'punct' && t.value === '[') {
      let m = k + 1;
      let count = 0;
      while (m + 1 < sig.length && toks[sig[m]].type === 'string') {
        count++;
        const sep = toks[sig[m + 1]].value;
        if (sep === ']') break;
        if (sep !== ',') { count = 0; break; }
        m += 2;
      }
      if (count > largestStringArray) largestStringArray = count;
    }
    if ((t.type === 'name' || t.type === 'string') && lastPush >= 0 && lastShift >= 0 && Math.abs(lastPush - lastShift) <= 20) {
      rotateIIFE = true;
    }
  }
  const stringArray = largestStringArray >= 50;

  return {
    code: out.join(''),
    changes,
    signals: {
      obfuscatorIdentifiers: obfIds,
      uniqueObfuscatorIdentifiers: uniqueObf.size,
      stringArray,
      largestStringArray,
      rotateIIFE: rotateIIFE && stringArray,
      eval: evalCount,
      newFunction,
      functionCall,
      embedded,
    },
  };
}

/**
 * @param {string} src
 * @param {number} start content start (after quote)
 * @param {number} end content end (before quote)
 * @param {Embedded[]} out
 */
function detectEmbedded(src, start, end, out) {
  const head = src.slice(start, Math.min(end, start + 200));
  const m = /^data:[^,;]*(?:;[^,;]*)*;base64,/.exec(head);
  if (m) start += m[0].length;
  if (end - start < 4096) return;
  const body = src.slice(start, end);
  if (!B64_RE.test(body)) return;
  const bytes = Buffer.from(body.slice(0, 16).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const hex = bytes.toString('hex');
  let kind = 'unknown';
  if (hex.startsWith('0061736d')) kind = 'wasm';
  else if (hex.startsWith('89504e47')) kind = 'png';
  else if (hex.startsWith('1f8b')) kind = 'gzip';
  else if (hex.startsWith('504b0304')) kind = 'zip';
  else if (hex.startsWith('25504446')) kind = 'pdf';
  out.push({ start, end, length: end - start, kind });
}

/**
 * Decode printable \xNN / \uNNNN escapes in a quoted string literal (quote style kept).
 * @param {string} lit
 * @returns {{ text: string, count: number }}
 */
function decodeEscapes(lit) {
  let out = '';
  let count = 0;
  let i = 0;
  while (i < lit.length) {
    const ch = lit[i];
    if (ch !== '\\') { out += ch; i++; continue; }
    const kind = lit[i + 1];
    let hex = '';
    if (kind === 'x' && /^[0-9a-fA-F]{2}$/.test(lit.slice(i + 2, i + 4))) hex = lit.slice(i + 2, i + 4);
    else if (kind === 'u' && /^[0-9a-fA-F]{4}$/.test(lit.slice(i + 2, i + 6))) hex = lit.slice(i + 2, i + 6);
    if (hex) {
      const code = parseInt(hex, 16);
      if (printable(code)) {
        out += String.fromCharCode(code);
        count++;
        i += 2 + hex.length;
        continue;
      }
    }
    out += lit.slice(i, i + 2);
    i += 2;
  }
  return { text: out, count };
}

/** @param {number} c */
function printable(c) {
  if (c < 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad) return false;
  if (c === 0x22 || c === 0x27 || c === 0x60 || c === 0x5c) return false;
  if (c === 0x2028 || c === 0x2029 || (c >= 0xd800 && c <= 0xdfff)) return false;
  if ((c >= 0x200b && c <= 0x200f) || c === 0xfeff || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f)) return false;
  if (c >= 0xfff0) return false;
  return true;
}
