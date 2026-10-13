// @ts-check
import { Buffer } from 'node:buffer';
// Payloads embedded in native binaries:
// - Bun standalone executables (`bun build --compile`): the module graph in the `.bun` PE section
//   (or appended to the file), ending with a 32-byte offsets struct and the "---- Bun! ----" trailer.
// - Rust build paths left in panic/debug strings: crates.io and git dependencies with versions,
//   first-party source files, and the rustc commit.

export const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const BUN_ROOTS = /^(?:B:\/~BUN\/root\/|\/\$bunfs\/root\/)/;
const RECORD_SIZES = [52, 48, 56, 44, 40, 64, 36, 32];

/**
 * Parse a Bun standalone module graph from a buffer holding the whole file or its `.bun` section.
 * Layout (Bun 1.1-1.3): [data: byteCount bytes][offsets: u64 byteCount, u32 modulesOff, u32 modulesLen,
 * u32 entryPointId, u32 argvOff, u32 argvLen, u32 flags][trailer]. Offsets are relative to data start.
 * Module records are a fixed-size array whose first four fields are {u32 off, u32 len} pointers:
 * name, contents, sourcemap, bytecode. The record size is inferred (all names must decode under the Bun root).
 * @param {Buffer} buf
 * @returns {null | { dataOffset: number, byteCount: number, entryPoint: string|null, execArgv: string, flags: number, recordSize: number,
 *   modules: { name: string, path: string, offset: number, size: number, sourcemapBytes: number, bytecodeBytes: number }[] }}
 */
export function parseBunGraph(buf) {
  const tp = buf.lastIndexOf(BUN_TRAILER);
  if (tp < 32) return null;
  const op = tp - 32;
  const byteCount = Number(buf.readBigUInt64LE(op));
  const base = op - byteCount;
  if (byteCount <= 0 || base < 0) return null;
  const u32 = (/** @type {number} */ o) => buf.readUInt32LE(o);
  const mOff = u32(op + 8), mLen = u32(op + 12), entry = u32(op + 16), aOff = u32(op + 20), aLen = u32(op + 24), flags = u32(op + 28);
  if (mOff + mLen > byteCount || !mLen) return null;
  const inData = (/** @type {number} */ o, /** @type {number} */ l) => o + l <= byteCount;
  const nameAt = (/** @type {number} */ rec) => {
    const o = u32(rec), l = u32(rec + 4);
    if (!l || l > 4096 || !inData(o, l)) return null;
    const s = buf.subarray(base + o, base + o + l).toString('utf8');
    return BUN_ROOTS.test(s) ? s : null;
  };
  for (const size of RECORD_SIZES) {
    if (mLen % size) continue;
    const n = mLen / size;
    const modules = [];
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const rec = base + mOff + i * size;
      const name = nameAt(rec);
      const cOff = u32(rec + 8), cLen = u32(rec + 12);
      if (!name || !inData(cOff, cLen)) { ok = false; break; }
      modules.push({ name, path: name.replace(BUN_ROOTS, ''), offset: base + cOff, size: cLen, sourcemapBytes: u32(rec + 20), bytecodeBytes: u32(rec + 28) });
    }
    if (!ok) continue;
    const execArgv = aLen && inData(aOff, aLen) ? buf.subarray(base + aOff, base + aOff + aLen).toString('utf8').replace(/\0+$/, '') : '';
    return { dataOffset: base, byteCount, entryPoint: modules[entry]?.path ?? null, execArgv, flags, recordSize: size, modules };
  }
  return null;
}

/**
 * Safe relative output path for an embedded module name (no escaping, Windows-safe characters).
 * @param {string} p
 */
export function safeModulePath(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
  return parts.length ? parts.join('/') : null;
}

/**
 * Rust provenance from strings in a binary (pass the file decoded as latin1).
 * @param {string} text
 */
export function rustSources(text) {
  /** @type {Map<string, Set<string>>} */
  const crates = new Map();
  for (const m of text.matchAll(/\.cargo[\\/]registry[\\/]src[\\/][^\\/\0\n]{1,80}[\\/]([A-Za-z0-9_][\w-]*?)-(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)[\\/]/g)) {
    if (!crates.has(m[1])) crates.set(m[1], new Set());
    crates.get(m[1])?.add(m[2]);
  }
  /** @type {Map<string, Set<string>>} */
  const git = new Map();
  for (const m of text.matchAll(/\.cargo[\\/]git[\\/]checkouts[\\/]([\w.-]+?)-[0-9a-f]{16}[\\/]([0-9a-f]{7,40})[\\/]/g)) {
    if (!git.has(m[1])) git.set(m[1], new Set());
    git.get(m[1])?.add(m[2]);
  }
  // first-party: workspace-relative sources (crates/<name>/src/x.rs, src/x.rs). The lookbehind keeps
  // matches out of cargo-cache paths (preceded by a separator) and out of URLs/words.
  const sources = new Set();
  /** @type {Map<string, number>} */
  const roots = new Map();
  for (const m of text.matchAll(/(?<![\w.\\/:-])((?:crates|src|native|apps|engine|packages)[\\/][\w\\/.-]{1,200}?\.rs)(?!\w)/g)) {
    const p = m[1].replace(/\\/g, '/');
    if (sources.has(p)) continue;
    sources.add(p);
    const root = /^(?:crates|native|apps|engine|packages)\/[^/]+/.exec(p)?.[0] ?? p.split('/')[0];
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  // CI checkouts: C:\runner\_work\<repo>\<repo>\..., D:\a\<repo>\<repo>\..., /home/runner/work/<repo>/<repo>/...
  const ciRepos = [...new Set([...text.matchAll(/[\\/](?:_?work|a)[\\/]([\w.-]{2,80})[\\/]\1[\\/]/g)].map((m) => m[1]))].sort();
  const rustc = [...new Set([...text.matchAll(/\/rustc\/([0-9a-f]{40})\//g)].map((m) => m[1]))];
  const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    rustc,
    crates: [...crates].map(([name, v]) => ({ name, versions: [...v].sort() })).sort((a, b) => cmp(a.name, b.name)),
    git: [...git].map(([name, revs]) => ({ name, revs: [...revs].sort() })).sort((a, b) => cmp(a.name, b.name)),
    ciRepos,
    sourceRoots: [...roots].map(([root, files]) => ({ root, files })).sort((a, b) => b.files - a.files || cmp(a.root, b.root)),
    sources: [...sources].sort(cmp),
  };
}
