// Zero-dependency decoder for the NSIS 3 script header (non-solid, deflate-compressed headers).
// Decodes sections, functions and instructions into a readable pseudo-script plus a summary of
// side effects (registry, shortcuts, files, exec, plugin calls). LZMA/bzip2 headers are reported,
// not decoded.
import { inflateRawSync } from 'node:zlib';

/** NSIS 3 opcodes (default config: no NSIS_CONFIG_LOG). Indices >= 63 vary between NSIS releases. */
const OPS = [
  'Invalid', 'Return', 'Goto', 'Abort', 'Quit', 'Call', 'DetailPrint', 'Sleep', 'BringToFront', 'SetDetailsView',
  'SetFileAttributes', 'CreateDirectory', 'IfFileExists', 'SetFlag', 'IfFlag', 'GetFlag', 'Rename', 'GetFullPathName',
  'SearchPath', 'GetTempFileName', 'File', 'Delete', 'MessageBox', 'RMDir', 'StrLen', 'StrCpy', 'StrCmp',
  'ReadEnvStr', 'IntCmp', 'IntOp', 'IntFmt', 'PushPop', 'FindWindow', 'SendMessage', 'IsWindow', 'GetDlgItem',
  'SetCtlColors', 'LoadAndSetImage', 'CreateFont', 'ShowWindow', 'ExecShell', 'Exec', 'GetFileTime',
  'GetDLLVersion', 'RegisterDLL', 'CreateShortcut', 'CopyFiles', 'Reboot', 'WriteINIStr', 'ReadINIStr',
  'DeleteReg', 'WriteReg', 'ReadReg', 'EnumReg', 'FileClose', 'FileOpen', 'FileWrite', 'FileRead', 'FileSeek',
  'FindClose', 'FindNext', 'FindFirst', 'WriteUninstaller',
];

const VARS = ['CMDLINE', 'INSTDIR', 'OUTDIR', 'EXEDIR', 'LANGUAGE', 'TEMP', 'PLUGINSDIR', 'EXEPATH', 'EXEFILE', 'HWNDPARENT', '_CLICK', '_OUTDIR'];

/** @type {Record<number,string>} CSIDL -> NSIS shell constant */
const SHELL = {
  0x00: 'DESKTOP', 0x02: 'SMPROGRAMS', 0x05: 'DOCUMENTS', 0x06: 'FAVORITES', 0x07: 'SMSTARTUP', 0x08: 'RECENT',
  0x09: 'SENDTO', 0x0b: 'STARTMENU', 0x0d: 'MUSIC', 0x0e: 'VIDEOS', 0x10: 'DESKTOP', 0x13: 'NETHOOD', 0x14: 'FONTS',
  0x15: 'TEMPLATES', 0x16: 'STARTMENU', 0x17: 'SMPROGRAMS', 0x18: 'SMSTARTUP', 0x19: 'DESKTOP', 0x1a: 'APPDATA',
  0x1b: 'PRINTHOOD', 0x1c: 'LOCALAPPDATA', 0x1f: 'FAVORITES', 0x20: 'INTERNET_CACHE', 0x21: 'COOKIES',
  0x22: 'HISTORY', 0x23: 'APPDATA', 0x24: 'WINDIR', 0x25: 'SYSDIR', 0x26: 'PROGRAMFILES', 0x27: 'PICTURES',
  0x28: 'PROFILE', 0x2b: 'COMMONFILES', 0x2e: 'DOCUMENTS', 0x2f: 'ADMINTOOLS', 0x30: 'ADMINTOOLS',
  0x35: 'MUSIC', 0x36: 'PICTURES', 0x37: 'VIDEOS', 0x38: 'RESOURCES', 0x39: 'RESOURCES_LOCALIZED', 0x3b: 'CDBURN_AREA',
};

const ROOTS = { 0: 'SHCTX', 0x80000000: 'HKCR', 0x80000001: 'HKCU', 0x80000002: 'HKLM', 0x80000003: 'HKU' };
const CALLBACKS = ['.onInit', '.onInstSuccess', '.onInstFailed', '.onUserAbort', '.onGUIInit', '.onGUIEnd',
  '.onMouseOverSection', '.onVerifyInstDir', '.onSelChange', '.onRebootFailed'];

/** @param {number} v */
function rootName(v) {
  const u = v >>> 0;
  const view = u & 0x40000000 ? '32' : u & 0x20000000 ? '64' : '';
  const base = /** @type {Record<number,string>} */ (ROOTS)[(u & ~0x60000000) >>> 0];
  return base ? base + view : `ROOT(0x${u.toString(16)})`;
}

/**
 * Locate the firstheader ("\xEF\xBE\xAD\xDE" + "NullsoftInst") and return the decompressed header.
 * @param {Buffer} buf whole installer (or at least stub + firstheader + header block)
 */
export function readNsisHeader(buf) {
  const sig = buf.indexOf(Buffer.from('NullsoftInst', 'latin1'));
  if (sig < 8) throw new Error('no NSIS firstheader');
  const fh = sig - 8;
  const flags = buf.readUInt32LE(fh);
  const headerLen = buf.readUInt32LE(sig + 12);
  const dataStart = sig + 20;
  const first = buf.readUInt32LE(dataStart);
  let header;
  let compression;
  if (first === headerLen) { header = buf.subarray(dataStart + 4, dataStart + 4 + headerLen); compression = 'stored'; } // uncompressed
  else if (first & 0x80000000) {
    const size = first & 0x7fffffff;
    const data = buf.subarray(dataStart + 4, dataStart + 4 + size);
    if (data[0] === 0x5d) throw new Error('NSIS header is LZMA-compressed: not decoded (no zero-dep LZMA decoder)');
    try { header = inflateRawSync(data); compression = 'deflate'; }
    catch { throw new Error('NSIS header is not deflate (bzip2/LZMA or solid): not decoded'); }
  } else throw new Error('NSIS solid archive: header not decoded');
  if (header.length !== headerLen) throw new Error(`NSIS header size mismatch (${header.length} != ${headerLen})`);
  return { header, flags, uninstaller: (flags & 1) === 1, compression, firstHeaderOffset: fh };
}

/**
 * Decode an NSIS 3 Unicode header into sections, functions and instructions.
 * @param {Buffer} h decompressed header
 */
export function decodeNsisHeader(h) {
  const i32 = (/** @type {number} */ o) => h.readInt32LE(o);
  const blocks = [];
  for (let b = 0; b < 8; b++) blocks.push({ offset: i32(4 + b * 8), num: i32(8 + b * 8) });
  const [pages, sections, entries, strings, langs] = blocks;
  const unicode = h.readUInt16LE(strings.offset) === 0 && h.readUInt16LE(strings.offset + 2) !== 0 && h[strings.offset + 3] === 0;
  if (!unicode) throw new Error('only NSIS 3 Unicode headers are decoded');
  const strEnd = langs.offset;
  const langTableSize = i32(68 + 12 + 12 + 8);
  /** @param {number} idx */
  const langStr = (idx) => {
    if (langs.num < 1) return `$(LSTR_${idx})`;
    const o = langs.offset + 10 + idx * 4;
    if (idx < 0 || o + 4 > langs.offset + langTableSize) return `$(LSTR_${idx})`;
    return str(i32(o));
  };
  /** @param {number} n */
  const varName = (n) => (n < 10 ? `$${n}` : n < 20 ? `$R${n - 10}` : n - 20 < VARS.length ? `$${VARS[n - 20]}` : `$_${n}_`);
  /** @param {number} off  string-table offset in chars (negative = language string) */
  function str(off, depth = 0) {
    if (off < 0) return depth > 2 ? '' : langStr(-(off + 1));
    let p = strings.offset + off * 2;
    let s = '';
    while (p + 1 < strEnd) {
      const c = h.readUInt16LE(p); p += 2;
      if (c === 0) break;
      if (c > 4) { s += String.fromCharCode(c); continue; }
      const n = h.readUInt16LE(p); p += 2;
      if (c === 4) s += String.fromCharCode(n);
      else if (c === 3) s += varName(n & 0x7fff);
      else if (c === 1) s += `$(LSTR_${n & 0x7fff})`;
      else {
        const a = n & 0xff, b = n >> 8;
        if (a & 0x80) s += (b & 0x40 ? '$COMMONFILES' : '$PROGRAMFILES') + ((a & 0x40) || (b & 0x40) ? '' : '');
        else s += `$${SHELL[b & 0x3f] ?? SHELL[a & 0x3f] ?? `SHELL(0x${n.toString(16)})`}`;
      }
    }
    return s;
  }
  const q = (/** @type {number} */ o) => JSON.stringify(str(o));

  // header fields after blocks
  const after = 68;
  const cbBase = after + 12 + 12 + 8 + 4 + 4;
  /** @type {Map<number,string>} entry index -> function label */
  const labels = new Map();
  CALLBACKS.forEach((name, k) => { const e = i32(cbBase + k * 4); if (e >= 0) labels.set(e, name); });
  const instDirPtr = cbBase + 40 + 33 * 4;
  const meta = {
    installDir: str(i32(instDirPtr)),
    uninstallChild: str(i32(instDirPtr + 8)),
    uninstallCmd: str(i32(instDirPtr + 12)),
    installDirRegKey: i32(after + 4) ? `${rootName(i32(after))}\\${str(i32(after + 4))}` : '',
  };

  // sections
  const secSize = sections.num ? (entries.offset - sections.offset) / sections.num : 0;
  const sects = [];
  for (let k = 0; k < sections.num; k++) {
    const o = sections.offset + k * secSize;
    sects.push({ name: str(i32(o)), flags: i32(o + 8), code: i32(o + 12), codeSize: i32(o + 16), sizeKb: i32(o + 20) });
  }
  // instructions
  const ins = [];
  for (let k = 0; k < entries.num; k++) {
    const o = entries.offset + k * 28;
    ins.push({ op: i32(o), a: [1, 2, 3, 4, 5, 6].map((j) => i32(o + j * 4)) });
  }
  for (const e of ins) if (e.op === 5 && e.a[0] > 0 && !labels.has(e.a[0] - 1)) labels.set(e.a[0] - 1, `func_${e.a[0] - 1}`);
  // plugin call arg pushes resolve the label names
  const sectionStarts = new Map(sects.map((s, k) => [s.code, `Section ${JSON.stringify(s.name || `#${k}`)}`]));

  const effects = { registry: [], shortcuts: [], files: [], deletes: [], exec: [], plugins: [], uninstaller: [], ini: [], directories: [] };
  /** @type {string[]} */
  const pending = []; // recent Push values (plugin args)
  const lines = [];
  for (let k = 0; k < ins.length; k++) {
    const { op, a } = ins[k];
    if (labels.has(k)) lines.push('', `Function ${labels.get(k)}  ; @${k}`);
    if (sectionStarts.has(k)) lines.push('', `${sectionStarts.get(k)}  ; @${k}`);
    const name = OPS[op] ?? `Op${op}`;
    let t;
    switch (op) {
      case 1: t = 'Return'; break;
      case 2: t = a[0] ? `Goto @${a[0] - 1}` : 'Nop'; break;
      case 5: t = `Call ${labels.get(a[0] - 1) ?? `@${a[0] - 1}`}`; break;
      case 6: t = `DetailPrint ${q(a[0])}`; break;
      case 11: t = `CreateDirectory ${q(a[0])}${a[1] ? ' ; SetOutPath' : ''}`; effects.directories.push(str(a[0])); break;
      case 12: t = `IfFileExists ${q(a[0])} @${a[1] - 1} @${a[2] - 1}`; break;
      case 16: t = `Rename ${q(a[0])} ${q(a[1])}`; break;
      case 20: t = `File ${q(a[1])}`; effects.files.push(str(a[1])); break;
      case 21: t = `Delete ${q(a[0])}`; effects.deletes.push(str(a[0])); break;
      case 22: t = `MessageBox 0x${(a[0] >>> 0).toString(16)} ${q(a[1])}`; break;
      case 23: t = `RMDir${a[1] & 2 ? ' /r' : ''} ${q(a[0])}`; effects.deletes.push(`${a[1] & 2 ? 'RMDir /r ' : 'RMDir '}${str(a[0])}`); break;
      case 25: t = `StrCpy ${varName(a[0])} ${q(a[1])}`; break;
      case 26: t = `StrCmp${a[4] ? 'S' : ''} ${q(a[0])} ${q(a[1])} @${a[2] - 1} @${a[3] - 1}`; break;
      case 27: t = `${a[2] ? 'ReadEnvStr' : 'ExpandEnvStrings'} ${varName(a[0])} ${q(a[1])}`; break;
      case 31:
        if (a[1]) t = `Pop ${varName(a[0])}`;
        else if (a[2]) t = `Exch ${a[2]}`;
        else { t = `Push ${q(a[0])}`; pending.push(str(a[0])); if (pending.length > 12) pending.shift(); }
        break;
      case 40: t = `ExecShell ${q(a[1])} ${q(a[2])} ${q(a[3])}`; effects.exec.push(`ExecShell ${str(a[1])} ${str(a[2])} ${str(a[3])}`.trim()); break;
      case 41: t = `Exec${a[1] ? 'Wait' : ''} ${q(a[0])}`; effects.exec.push(str(a[0])); break;
      case 44: {
        const dll = str(a[0]);
        const fn = str(a[1]);
        t = `CallPlugin ${JSON.stringify(dll)}::${fn}`;
        const plugin = dll.replace(/^.*[\\/]/, '').replace(/\.dll$/i, '');
        effects.plugins.push(`${plugin}::${fn}${pending.length ? ` (${pending.slice(-3).map((x) => JSON.stringify(x)).join(', ')})` : ''}`);
        pending.length = 0;
        break;
      }
      case 45: t = `CreateShortcut ${q(a[0])} ${q(a[1])} ${q(a[2])} ${q(a[3])}`; effects.shortcuts.push({ link: str(a[0]), target: str(a[1]), args: str(a[2]), icon: str(a[3]) }); break;
      case 46: t = `CopyFiles ${q(a[0])} ${q(a[1])}`; break;
      case 48: t = `WriteINIStr ${q(a[3])} ${q(a[0])} ${q(a[1])} ${q(a[2])}`; effects.ini.push(`${str(a[3])} [${str(a[0])}] ${str(a[1])}=${str(a[2])}`); break;
      case 50: {
        // [reserved, root, key, value, action (bit 0: key)]
        const key = `${rootName(a[1])}\\${str(a[2])}`;
        if (a[4] & 1) { t = `DeleteRegKey ${key}`; effects.registry.push({ op: 'DeleteRegKey', key }); }
        else { t = `DeleteRegValue ${key} ${q(a[3])}`; effects.registry.push({ op: 'DeleteRegValue', key, name: str(a[3]) }); }
        break;
      }
      case 51: {
        const key = `${rootName(a[0])}\\${str(a[1])}`;
        // a[4]: 1 string (a[5]: 1 REG_SZ, 2 REG_EXPAND_SZ), 3 binary (a[3] = data offset), 4 dword (a[3] = string)
        const kindName = a[4] === 4 ? 'WriteRegDWORD' : a[4] === 3 ? 'WriteRegBin' : a[5] === 2 ? 'WriteRegExpandStr' : 'WriteRegStr';
        const value = a[4] === 3 ? `<binary@${a[3]}>` : str(a[3]);
        t = `${kindName} ${key} ${q(a[2])} ${JSON.stringify(value)}`;
        effects.registry.push({ op: kindName, key, name: str(a[2]), value });
        break;
      }
      case 52: t = `ReadReg ${varName(a[0])} ${rootName(a[1])}\\${str(a[2])} ${q(a[3])}`; break;
      case 62: t = `WriteUninstaller ${q(a[0])}`; effects.uninstaller.push(str(a[0])); break;
      default: t = `${name} ${a.filter((x) => x).join(' ')}`.trim();
    }
    lines.push(`  ${String(k).padStart(5)}: ${t}`);
  }
  for (const key of Object.keys(effects)) {
    const list = /** @type {any[]} */ (/** @type {any} */ (effects)[key]);
    const seen = new Set();
    /** @type {any} */ (effects)[key] = list.filter((x) => { const s = JSON.stringify(x); if (seen.has(s)) return false; seen.add(s); return true; });
  }
  const protocols = [...new Set(effects.registry
    .filter((r) => r.op.startsWith('Write') && r.name === 'URL Protocol')
    .map((r) => r.key.replace(/^[^\\]+\\(?:Software\\Classes\\)?/i, '')))].sort();
  return {
    meta: { ...meta, pages: pages.num, sections: sects.length, instructions: ins.length, strings: strings.num, langTables: langs.num },
    sections: sects,
    functions: [...labels.entries()].sort((x, y) => x[0] - y[0]).map(([at, label]) => ({ at, label })),
    effects: { ...effects, protocols },
    script: lines.join('\n') + '\n',
  };
}
