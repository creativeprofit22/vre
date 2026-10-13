// @ts-check
// Pure PE (Portable Executable) parsing helpers. No file I/O: callers pass an `io` ({ size, read(off, len) -> Buffer }).

/** @typedef {{ size: number, read: (off: number, len: number) => Buffer }} IO */
/** @typedef {{ name: string, vaddr: number, vsize: number, rawPtr: number, rawSize: number, flags: string[], entropy?: number, packed?: boolean }} Section */
/** @typedef {{ dll: string, functions: string[] }} ImportDll */

export const MACHINES = /** @type {Record<number,string>} */ ({ 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64', 0x1c0: 'arm', 0x1c4: 'armnt', 0x200: 'ia64' });
export const SUBSYSTEMS = /** @type {Record<number,string>} */ ({ 1: 'native', 2: 'windows-gui', 3: 'windows-cui', 5: 'os2-cui', 7: 'posix-cui', 9: 'windows-ce-gui', 10: 'efi-application', 11: 'efi-boot-driver', 12: 'efi-runtime-driver', 14: 'xbox', 16: 'windows-boot-application' });
const FILE_CHARS = /** @type {[number,string][]} */ ([[0x1, 'relocs-stripped'], [0x2, 'executable'], [0x20, 'large-address-aware'], [0x100, '32bit-machine'], [0x200, 'debug-stripped'], [0x1000, 'system'], [0x2000, 'dll']]);
const DLL_CHARS = /** @type {[number,string][]} */ ([[0x20, 'high-entropy-va'], [0x40, 'aslr'], [0x80, 'force-integrity'], [0x100, 'dep'], [0x200, 'no-isolation'], [0x400, 'no-seh'], [0x1000, 'appcontainer'], [0x4000, 'cfg'], [0x8000, 'terminal-server-aware']]);
const SEC_CHARS = /** @type {[number,string][]} */ ([[0x20, 'code'], [0x40, 'idata'], [0x80, 'udata'], [0x02000000, 'discardable'], [0x10000000, 'shared'], [0x20000000, 'exec'], [0x40000000, 'read'], [0x80000000, 'write']]);
export const PACKED_ENTROPY = 7.2;
const MAX_NAMES = 5000;

/** @param {Buffer} buf @returns {IO} */
export function bufferIO(buf) {
  return { size: buf.length, read: (off, len) => buf.subarray(Math.max(0, Math.min(off, buf.length)), Math.max(0, Math.min(buf.length, off + len))) };
}

/** @param {number} v @param {[number,string][]} table */
const flags = (v, table) => table.filter(([b]) => (v & b) >>> 0 === b).map(([, n]) => n);

/** True if the buffer starts with MZ and points to a PE\0\0 signature inside the buffer. @param {Buffer} head */
export function isPE(head) {
  if (head.length < 64 || head.readUInt16LE(0) !== 0x5a4d) return false;
  const lf = head.readUInt32LE(0x3c);
  return lf + 4 <= head.length && head.readUInt32LE(lf) === 0x4550;
}

/** Shannon entropy (bits/byte) from a 256-bin histogram. @param {ArrayLike<number>} counts @param {number} total */
export function entropyFromCounts(counts, total) {
  if (!total) return 0;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i];
    if (c) { const p = c / total; h -= p * Math.log2(p); }
  }
  return h;
}

/** @param {Buffer} buf */
export function shannonEntropy(buf) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) counts[buf[i]]++;
  return entropyFromCounts(counts, buf.length);
}

/** @param {IO} io @param {number} off @param {number} [max] */
function cstr(io, off, max = 512) {
  const b = io.read(off, max);
  const z = b.indexOf(0);
  return b.toString('latin1', 0, z < 0 ? b.length : z);
}

/** File offset of an RVA, or -1. @param {Section[]} sections @param {number} rva @param {number} [headerSize] */
export function rvaToOffset(sections, rva, headerSize = 0) {
  if (rva < headerSize) return rva;
  for (const s of sections) {
    const span = Math.max(s.vsize, s.rawSize);
    if (rva >= s.vaddr && rva < s.vaddr + span) {
      const d = rva - s.vaddr;
      return d < s.rawSize ? s.rawPtr + d : -1;
    }
  }
  return -1;
}

/**
 * Parse a PE image. Sub-parsers are best-effort: failures go to `errors` instead of throwing.
 * @param {IO} io
 */
export function parsePE(io) {
  const dos = io.read(0, 64);
  if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) throw new Error('not an MZ file');
  const lfanew = dos.readUInt32LE(0x3c);
  const nt = io.read(lfanew, 24);
  if (nt.length < 24 || nt.readUInt32LE(0) !== 0x4550) throw new Error('no PE signature');
  const machine = nt.readUInt16LE(4);
  const nsec = nt.readUInt16LE(6);
  const timestamp = nt.readUInt32LE(8);
  const sizeOpt = nt.readUInt16LE(20);
  const characteristics = nt.readUInt16LE(22);
  const optOff = lfanew + 24;
  const opt = io.read(optOff, sizeOpt);
  if (opt.length < 2) throw new Error('truncated optional header');
  const magic = opt.readUInt16LE(0);
  const plus = magic === 0x20b;
  if (!plus && magic !== 0x10b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  const u32 = (/** @type {number} */ o) => (o + 4 <= opt.length ? opt.readUInt32LE(o) : 0);
  const u16 = (/** @type {number} */ o) => (o + 2 <= opt.length ? opt.readUInt16LE(o) : 0);
  const entryPoint = u32(16);
  const imageBase = plus ? (opt.length >= 32 ? Number(opt.readBigUInt64LE(24)) : 0) : u32(28);
  const sizeOfHeaders = u32(60);
  const subsystem = u16(68);
  const dllChars = u16(70);
  const ddOff = plus ? 112 : 96;
  const nDirs = Math.min(16, u32(plus ? 108 : 92));
  /** @type {{ rva: number, size: number }[]} */
  const dirs = [];
  for (let i = 0; i < 16; i++) dirs.push(i < nDirs ? { rva: u32(ddOff + i * 8), size: u32(ddOff + i * 8 + 4) } : { rva: 0, size: 0 });

  /** @type {Section[]} */
  const sections = [];
  const sh = io.read(optOff + sizeOpt, nsec * 40);
  for (let i = 0; i < nsec && (i + 1) * 40 <= sh.length; i++) {
    const o = i * 40;
    sections.push({
      name: sh.toString('latin1', o, o + 8).replace(/\0.*$/s, ''),
      vsize: sh.readUInt32LE(o + 8), vaddr: sh.readUInt32LE(o + 12),
      rawSize: sh.readUInt32LE(o + 16), rawPtr: sh.readUInt32LE(o + 20),
      flags: flags(sh.readUInt32LE(o + 36), SEC_CHARS),
    });
  }
  const off = (/** @type {number} */ rva) => rvaToOffset(sections, rva, sizeOfHeaders);
  /** @type {string[]} */
  const errors = [];
  /** @template T @param {string} what @param {() => T} fn @param {T} dflt @returns {T} */
  const tryDo = (what, fn, dflt) => {
    try { return fn(); } catch (e) { errors.push(`${what}: ${e instanceof Error ? e.message : e}`); return dflt; }
  };

  const imports = tryDo('imports', () => parseImports(io, off, dirs[1], plus), /** @type {ImportDll[]} */ ([]));
  const delayImports = tryDo('delay imports', () => parseDelayImports(io, off, dirs[13], plus, imageBase), /** @type {ImportDll[]} */ ([]));
  const exp = tryDo('exports', () => parseExports(io, off, dirs[0]), null);
  const version = tryDo('version resource', () => parseVersionResource(io, off, dirs[2]), null);
  const debug = tryDo('debug directory', () => parseDebug(io, off, dirs[6]), { pdb: null, guid: null });
  const sec = dirs[4];
  const security = sec.size ? { offset: sec.rva, size: sec.size } : null; // security dir holds a FILE offset, not an RVA
  const dosStub = io.read(0x40, Math.max(0, lfanew - 0x40));
  const rich = dosStub.indexOf('Rich') >= 0;
  const sectionEnd = sections.reduce((m, s) => Math.max(m, s.rawPtr + s.rawSize), sizeOfHeaders);
  const overlay = Math.max(0, io.size - sectionEnd);

  return {
    machine: MACHINES[machine] ?? `0x${machine.toString(16)}`,
    format: plus ? 'PE32+' : 'PE32',
    subsystem: SUBSYSTEMS[subsystem] ?? String(subsystem),
    timestamp,
    timestampIso: timestamp > 0 && timestamp < 0x7fffffff ? new Date(timestamp * 1000).toISOString() : null,
    characteristics: flags(characteristics, FILE_CHARS),
    dllCharacteristics: flags(dllChars, DLL_CHARS),
    isDll: (characteristics & 0x2000) !== 0,
    entryPoint, imageBase, sizeOfHeaders,
    sections,
    imports, delayImports,
    exports: exp,
    version,
    security,
    pdb: debug.pdb, pdbGuid: debug.guid,
    rich,
    dotnet: dirs[14].rva !== 0 && dirs[14].size !== 0,
    sectionEnd, overlay,
    // an overlay that is just the Authenticode blob is not hidden extra data
    overlayIsSignature: !!security && overlay > 0 && security.offset >= sectionEnd && security.offset + security.size >= io.size - 8,
    errors,
  };
}

/**
 * Read a thunk table (import names or ordinals).
 * @param {IO} io @param {(rva:number)=>number} off @param {number} rva @param {boolean} plus @param {number} [base] subtract from values (old-style delay imports use VAs)
 */
function readThunks(io, off, rva, plus, base = 0) {
  /** @type {string[]} */
  const out = [];
  let p = off(rva);
  if (p < 0) return out;
  const step = plus ? 8 : 4;
  for (let i = 0; i < MAX_NAMES; i++, p += step) {
    const b = io.read(p, step);
    if (b.length < step) break;
    const v = plus ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
    if (v === 0n) break;
    const ordFlag = plus ? 1n << 63n : 1n << 31n;
    if (v & ordFlag) { out.push(`#${Number(v & 0xffffn)}`); continue; }
    const hn = off(Number(v) - base);
    out.push(hn < 0 ? '?' : cstr(io, hn + 2, 256));
  }
  return out;
}

/** @param {IO} io @param {(rva:number)=>number} off @param {{rva:number,size:number}} dir @param {boolean} plus @returns {ImportDll[]} */
export function parseImports(io, off, dir, plus) {
  /** @type {ImportDll[]} */
  const out = [];
  if (!dir.rva) return out;
  let p = off(dir.rva);
  if (p < 0) throw new Error('import directory outside sections');
  for (let i = 0; i < 1024; i++, p += 20) {
    const d = io.read(p, 20);
    if (d.length < 20) break;
    const oft = d.readUInt32LE(0), nameRva = d.readUInt32LE(12), ft = d.readUInt32LE(16);
    if (!oft && !nameRva && !ft) break;
    const no = off(nameRva);
    out.push({ dll: no < 0 ? '?' : cstr(io, no, 256), functions: readThunks(io, off, oft || ft, plus) });
  }
  return out;
}

/** @param {IO} io @param {(rva:number)=>number} off @param {{rva:number,size:number}} dir @param {boolean} plus @param {number} imageBase @returns {ImportDll[]} */
export function parseDelayImports(io, off, dir, plus, imageBase) {
  /** @type {ImportDll[]} */
  const out = [];
  if (!dir.rva) return out;
  let p = off(dir.rva);
  if (p < 0) throw new Error('delay import directory outside sections');
  for (let i = 0; i < 1024; i++, p += 32) {
    const d = io.read(p, 32);
    if (d.length < 32) break;
    const attrs = d.readUInt32LE(0), nameV = d.readUInt32LE(4), intV = d.readUInt32LE(16);
    if (!nameV && !intV) break;
    const base = attrs & 1 ? 0 : imageBase; // attribute bit 0: values are RVAs (otherwise VAs)
    const no = off(nameV - base);
    out.push({ dll: no < 0 ? '?' : cstr(io, no, 256), functions: readThunks(io, off, intV - base, plus, base) });
  }
  return out;
}

/** @param {IO} io @param {(rva:number)=>number} off @param {{rva:number,size:number}} dir */
export function parseExports(io, off, dir) {
  if (!dir.rva) return null;
  const p = off(dir.rva);
  if (p < 0) throw new Error('export directory outside sections');
  const d = io.read(p, 40);
  if (d.length < 40) throw new Error('truncated export directory');
  const no = off(d.readUInt32LE(12));
  const nFuncs = d.readUInt32LE(20), nNames = d.readUInt32LE(24), namesRva = d.readUInt32LE(32);
  /** @type {string[]} */
  const names = [];
  const np = off(namesRva);
  if (np >= 0) {
    const n = Math.min(nNames, MAX_NAMES);
    const tbl = io.read(np, n * 4);
    for (let i = 0; i + 4 <= tbl.length; i += 4) {
      const o = off(tbl.readUInt32LE(i));
      names.push(o < 0 ? '?' : cstr(io, o, 256));
    }
  }
  return { dll: no < 0 ? null : cstr(io, no, 256), functions: nFuncs, names, truncated: nNames > names.length };
}

/** @param {IO} io @param {(rva:number)=>number} off @param {{rva:number,size:number}} dir */
export function parseDebug(io, off, dir) {
  const res = { pdb: /** @type {string|null} */ (null), guid: /** @type {string|null} */ (null) };
  if (!dir.rva || !dir.size) return res;
  const p = off(dir.rva);
  if (p < 0) throw new Error('debug directory outside sections');
  const n = Math.min(32, Math.floor(dir.size / 28));
  for (let i = 0; i < n; i++) {
    const e = io.read(p + i * 28, 28);
    if (e.length < 28 || e.readUInt32LE(12) !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
    const raw = io.read(e.readUInt32LE(24), Math.min(e.readUInt32LE(16), 1024));
    if (raw.length >= 24 && raw.toString('latin1', 0, 4) === 'RSDS') {
      const g = raw.subarray(4, 20);
      res.guid = [g.readUInt32LE(0).toString(16).padStart(8, '0'), g.readUInt16LE(4).toString(16).padStart(4, '0'), g.readUInt16LE(6).toString(16).padStart(4, '0'), g.subarray(8, 10).toString('hex'), g.subarray(10, 16).toString('hex')].join('-');
      const z = raw.indexOf(0, 24);
      res.pdb = raw.toString('utf8', 24, z < 0 ? raw.length : z);
      break;
    }
  }
  return res;
}

const align4 = (/** @type {number} */ n) => (n + 3) & ~3;

/** Parse one VS_VERSIONINFO-style block header. @param {Buffer} b @param {number} o */
function verBlock(b, o) {
  const len = b.readUInt16LE(o), vlen = b.readUInt16LE(o + 2), type = b.readUInt16LE(o + 4);
  let p = o + 6, key = '';
  while (p + 1 < b.length) { const c = b.readUInt16LE(p); p += 2; if (!c) break; key += String.fromCharCode(c); }
  return { o, len, vlen, type, key, valueOff: align4(p), end: Math.min(b.length, o + len) };
}

/** Children of a block whose value occupies `valueBytes`. @param {Buffer} b @param {ReturnType<typeof verBlock>} blk @param {number} valueBytes */
function verChildren(b, blk, valueBytes) {
  const out = [];
  let p = align4(blk.valueOff + valueBytes);
  while (p + 6 <= blk.end) {
    const c = verBlock(b, p);
    if (c.len < 6) break;
    out.push(c);
    p = align4(c.o + c.len);
  }
  return out;
}

/** Parse a VS_VERSIONINFO blob into { fileVersion, productVersion, strings }. @param {Buffer} b */
export function parseVersionInfo(b) {
  const root = verBlock(b, 0);
  if (root.key !== 'VS_VERSION_INFO') throw new Error('not a VS_VERSION_INFO block');
  /** @type {Record<string,string>} */
  const strings = {};
  let fileVersion = null, productVersion = null;
  if (root.vlen >= 52 && b.readUInt32LE(root.valueOff) === 0xfeef04bd) {
    const v = (/** @type {number} */ o) => `${b.readUInt16LE(o + 2)}.${b.readUInt16LE(o)}.${b.readUInt16LE(o + 6)}.${b.readUInt16LE(o + 4)}`;
    fileVersion = v(root.valueOff + 8);
    productVersion = v(root.valueOff + 16);
  }
  for (const sfi of verChildren(b, root, root.vlen)) {
    if (sfi.key !== 'StringFileInfo') continue;
    for (const table of verChildren(b, sfi, 0)) {
      for (const s of verChildren(b, table, 0)) {
        const bytes = s.type === 1 ? s.vlen * 2 : s.vlen;
        const v = b.toString('utf16le', s.valueOff, Math.min(s.end, s.valueOff + bytes)).replace(/\0+$/, '');
        if (!(s.key in strings)) strings[s.key] = v;
      }
    }
  }
  return { fileVersion, productVersion, strings };
}

/** Find RT_VERSION (16) in the resource tree and parse it. @param {IO} io @param {(rva:number)=>number} off @param {{rva:number,size:number}} dir */
export function parseVersionResource(io, off, dir) {
  if (!dir.rva) return null;
  const base = off(dir.rva);
  if (base < 0) throw new Error('resource directory outside sections');
  /** @param {number} dirOff @returns {{ id: number|null, off: number, isDir: boolean }[]} */
  const entries = (dirOff) => {
    const h = io.read(base + dirOff, 16);
    if (h.length < 16) return [];
    const n = Math.min(4096, h.readUInt16LE(12) + h.readUInt16LE(14));
    const e = io.read(base + dirOff + 16, n * 8);
    const out = [];
    for (let i = 0; i + 8 <= e.length; i += 8) {
      const name = e.readUInt32LE(i), data = e.readUInt32LE(i + 4);
      out.push({ id: name & 0x80000000 ? null : name, off: data & 0x7fffffff, isDir: (data & 0x80000000) !== 0 });
    }
    return out;
  };
  const type = entries(0).find((e) => e.id === 16 && e.isDir);
  if (!type) return null;
  let node = type;
  for (let depth = 0; depth < 2 && node?.isDir; depth++) node = entries(node.off)[0];
  if (!node || node.isDir) return null;
  const de = io.read(base + node.off, 8);
  const p = off(de.readUInt32LE(0));
  if (p < 0) throw new Error('version data outside sections');
  return parseVersionInfo(io.read(p, Math.min(de.readUInt32LE(4), 65536)));
}

/**
 * Best-effort subject names from an Authenticode (PKCS#7) blob: X.509 CN (2.5.4.3) and O (2.5.4.10) values.
 * The signer is guessed as the first CN that doesn't look like a CA / timestamping authority.
 * @param {Buffer} blob
 */
export function certNames(blob) {
  /** @type {string[]} */ const cn = [];
  /** @type {string[]} */ const org = [];
  for (let i = 0; i + 6 < blob.length; i++) {
    if (blob[i] !== 0x06 || blob[i + 1] !== 0x03 || blob[i + 2] !== 0x55 || blob[i + 3] !== 0x04) continue;
    const attr = blob[i + 4];
    if (attr !== 3 && attr !== 10) continue;
    const tag = blob[i + 5];
    let len = blob[i + 6], p = i + 7;
    if (len === 0x81) { len = blob[p]; p++; } else if (len === 0x82) { len = blob.readUInt16BE(p); p += 2; }
    if (![0x0c, 0x13, 0x14, 0x16, 0x1e].includes(tag) || p + len > blob.length) continue;
    const v = tag === 0x1e ? Buffer.from(blob.subarray(p, p + len)).swap16().toString('utf16le') : blob.toString('utf8', p, p + len);
    (attr === 3 ? cn : org).push(v);
  }
  const uniq = (/** @type {string[]} */ a) => [...new Set(a)];
  const isAuthority = (/** @type {string} */ s) => /\b(P?CA\d*|Root|Authority|Time.?Stamp\w*|TSA)\b|\bCA$/i.test(s);
  return { commonNames: uniq(cn), organizations: uniq(org), signer: cn.find((s) => !isAuthority(s)) ?? null };
}

/** Interesting-string categories. */
export const STRING_RULES = /** @type {[string, RegExp][]} */ ([
  ['url', /\b(?:https?|wss?|ftp):\/\/[^\s"'<>]{4,}/i],
  ['pipe', /\\\\\.\\pipe\\|\\\\\?\\pipe\\/i],
  ['registry', /\b(?:HKEY_[A-Z_]+|HKLM|HKCU)\b|^(?:SOFTWARE|Software|SYSTEM)\\[\w .-]+\\/],
  ['path', /^(?:[A-Za-z]:\\|\\\\[\w.$-]+\\|%[A-Z_]+%\\|\/(?:usr|home|Users|tmp|opt|var)\/)/],
  ['envvar', /%[A-Z_][A-Z0-9_]{2,}%/],
  ['toolchain', /Go build ID|go1\.\d+|\/rustc\/[0-9a-f]{8}|rustc |\.cargo[\\/]registry|MSVC|Microsoft \(R\) Optimizing|GCC: \(|clang version|PyInstaller|_MEIPASS|python3\d*\.dll|Nuitka|Qt5Core|Qt6Core|Electron\/\d/],
  ['shell', /\brunas\b|cmd\.exe|powershell(?:\.exe)?|schtasks|bcdedit|netsh|reg(?:\.exe)? add/i],
  ['ipc', /\b(?:Global|Local)\\[\w.-]{4,}/],
]);

/**
 * Streaming extractor for printable ASCII and UTF-16LE strings (min length `min`). Keeps only strings matching
 * STRING_RULES (capped per category) and counts the rest.
 */
export class StringScanner {
  constructor(min = 6, capPerCategory = 150) {
    this.min = min;
    this.cap = capPerCategory;
    /** @type {Record<string, Set<string>>} */
    this.found = {};
    this.total = 0;
    /** @type {number[]} */ this.ascii = [];
    /** @type {[number[], number[]]} */ this.wide = [[], []];
    /** @type {[number, number]} */ this.wideEnd = [-10, -10];
    this.pos = 0;
    this.prev = -1;
  }

  /** @param {number[]} codes */
  flush(codes) {
    if (codes.length >= this.min) {
      this.total++;
      const s = String.fromCharCode(...codes.slice(0, 600)).trim();
      for (const [cat, re] of STRING_RULES) {
        const m = re.exec(s);
        if (!m) continue;
        const v = cat === 'url' ? m[0].replace(/["',;)\]}]+$/, '') : s;
        const set = (this.found[cat] ??= new Set());
        if (set.size < this.cap) set.add(v.length > 300 ? `${v.slice(0, 300)}...` : v);
        break;
      }
    }
    codes.length = 0;
  }

  /** @param {Buffer} buf */
  feed(buf) {
    const asc = this.ascii;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      const printable = (b >= 0x20 && b < 0x7f) || b === 0x09;
      if (printable) { if (asc.length < 4096) asc.push(b); } else if (asc.length) this.flush(asc);
      // UTF-16LE: a printable byte followed by 0x00 forms one char ending at this position
      const p = this.prev;
      if (b === 0 && p >= 0x20 && p < 0x7f) {
        const g = this.pos + i, par = g & 1, run = this.wide[par];
        if (this.wideEnd[par] !== g - 2 && run.length) this.flush(run);
        if (run.length < 4096) run.push(p);
        this.wideEnd[par] = g;
      }
      this.prev = b;
    }
    this.pos += buf.length;
  }

  finish() {
    this.flush(this.ascii);
    this.flush(this.wide[0]);
    this.flush(this.wide[1]);
    return { total: this.total, interesting: Object.fromEntries(Object.entries(this.found).map(([k, v]) => [k, [...v].sort()])) };
  }
}

/**
 * Summarise build toolchains from 'toolchain' strings and the PDB path.
 * @param {string[]} strs @param {string|null} pdb
 */
export function toolchains(strs, pdb) {
  const out = new Set();
  const rust = strs.map((s) => /\/rustc\/([0-9a-f]{40})/.exec(s)?.[1]).find(Boolean);
  if (rust) out.add(`Rust (rustc commit ${rust.slice(0, 12)})`);
  else if (strs.some((s) => /rustc |\.cargo[\\/]registry/.test(s))) out.add('Rust');
  const go = strs.map((s) => /go1\.\d+(\.\d+)?/.exec(s)?.[0]).find(Boolean);
  if (go || strs.some((s) => s.includes('Go build ID'))) out.add(`Go${go ? ` (${go})` : ''}`);
  if (strs.some((s) => /PyInstaller|_MEIPASS/.test(s))) out.add('PyInstaller (Python)');
  if (strs.some((s) => /Nuitka/.test(s))) out.add('Nuitka (Python)');
  if (strs.some((s) => /GCC: \(/.test(s))) out.add('GCC/MinGW');
  if (strs.some((s) => /clang version/.test(s))) out.add('clang');
  if (strs.some((s) => /Qt[56]Core/.test(s))) out.add('Qt');
  if (pdb && /electron\.exe\.pdb$/i.test(pdb)) out.add('Electron (Chromium)');
  return [...out];
}

/** Capability evidence from imported API names. */
export const CAPABILITIES = /** @type {[string, RegExp, RegExp|null][]} */ ([
  // [capability, dll pattern, function pattern (null = any import from that dll)]
  ['network', /^(ws2_32|wsock32|winhttp|wininet|iphlpapi|dnsapi|mswsock|websocket|ncrypt|secur32)\.dll$/i, null],
  ['process-control', /^kernel32\.dll$/i, /^(CreateProcess\w*|OpenProcess|TerminateProcess|CreateRemoteThread\w*|WriteProcessMemory|ReadProcessMemory|VirtualAllocEx|DebugActiveProcess)$/],
  ['process-enumeration', /^(kernel32|psapi|ntdll)\.dll$/i, /^(CreateToolhelp32Snapshot|Process32(First|Next)W?|EnumProcesses|K32EnumProcesses|NtQuerySystemInformation|K32GetProcessMemoryInfo|GetProcessTimes|GetSystemTimes|QueryFullProcessImageNameW?)$/],
  ['performance-counters', /^(pdh|kernel32)\.dll$/i, /^(Pdh\w+|GlobalMemoryStatusEx|GetPerformanceInfo|K32GetPerformanceInfo)$/],
  ['elevation', /^(shell32|advapi32)\.dll$/i, /^(ShellExecute(Ex)?[AW]?|CreateProcessAsUserW?|CreateProcessWithTokenW|AdjustTokenPrivileges|CheckTokenMembership|GetTokenInformation)$/],
  ['registry', /^advapi32\.dll$/i, /^Reg\w+$/],
  ['services', /^advapi32\.dll$/i, /^(OpenSCManager\w*|CreateService\w*|StartService\w*|ControlService)$/],
  ['crypto', /^(bcrypt|crypt32|ncrypt|advapi32)\.dll$/i, /^(BCrypt\w+|Crypt\w+|CertOpen\w*|NCrypt\w+|CryptProtectData|CryptUnprotectData)$/],
  ['audio', /^(winmm|dsound|avrt|mmdevapi|audioses|ksuser)\.dll$/i, null],
  ['com-ole', /^(ole32|oleaut32|combase)\.dll$/i, /^(CoCreateInstance\w*|CoInitialize\w*)$/],
  ['screen-capture', /^(gdi32|dxgi|d3d11|d3d12|user32|dwmapi)\.dll$/i, /^(BitBlt|StretchBlt|CreateDXGIFactory\w*|D3D11CreateDevice\w*|D3D12CreateDevice|GetDC|PrintWindow|DwmGetWindowAttribute)$/],
  ['input-hooks', /^user32\.dll$/i, /^(SetWindowsHookEx[AW]|GetAsyncKeyState|GetKeyState|RegisterRawInputDevices|GetRawInputData|SendInput|keybd_event|mouse_event|BlockInput)$/],
  ['clipboard', /^user32\.dll$/i, /^(OpenClipboard|GetClipboardData|SetClipboardData)$/],
  ['ui-automation', /^(uiautomationcore|oleacc)\.dll$/i, null],
  ['dynamic-loading', /^kernel32\.dll$/i, /^(LoadLibrary\w*|GetProcAddress)$/],
  ['file-system', /^kernel32\.dll$/i, /^(CreateFile[AW]|DeleteFile[AW]|MoveFileEx?[AW]|FindFirstFile\w*|ReadDirectoryChangesW)$/],
  ['named-pipes', /^kernel32\.dll$/i, /^(CreateNamedPipe[AW]|ConnectNamedPipe|CallNamedPipe[AW])$/],
  ['node-api', /^(node|node\.exe|.*\.exe)$/i, /^napi_\w+$/],
]);

/** @param {ImportDll[]} imports */
export function capabilities(imports) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const { dll, functions } of imports) {
    for (const [cap, dllRe, fnRe] of CAPABILITIES) {
      if (!dllRe.test(dll)) continue;
      const hits = fnRe ? functions.filter((f) => fnRe.test(f)) : [`${dll}`];
      if (!hits.length) continue;
      const set = new Set(out[cap] ?? []);
      for (const h of hits) if (set.size < 12) set.add(fnRe ? `${dll.toLowerCase()}!${h}` : h.toLowerCase());
      out[cap] = [...set];
    }
  }
  // napi_* imports can come from any host module name (node.exe, Voyager.exe, ...)
  const napi = imports.flatMap((d) => d.functions.filter((f) => /^napi_/.test(f)));
  if (napi.length) out['node-api'] = [`${napi.length} napi_* functions`];
  return out;
}
