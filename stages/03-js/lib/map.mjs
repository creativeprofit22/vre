// @ts-check
// Pure scan helpers that build the app-level map (packages, first-party modules,
// Electron surface, network, env, debug ids). Regex-based best effort.

import { normalizeRegionPath } from './regions.mjs';

/**
 * name@version from a region path inside node_modules (pnpm layout preferred).
 * @param {string} regionPath
 * @returns {{ name: string, version: string|null }|null}
 */
export function packageFromPath(regionPath) {
  const p = regionPath.replace(/\\/g, '/');
  const pn = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(p);
  if (pn) {
    const [, dir, name] = pn;
    const esc = name.replace('/', '+');
    let version = null;
    if (dir.startsWith(`${esc}@`)) version = dir.slice(esc.length + 1).split(/[_(]/)[0] || null;
    return { name, version };
  }
  const all = [...p.matchAll(/node_modules\/(@[^/]+\/[^/]+|[^/.][^/]*)/g)];
  if (all.length) return { name: all[all.length - 1][1], version: null };
  return null;
}

/**
 * Group key for a first-party region path ("packages/<pkg>", "apps/<app>", else first folder).
 * @param {string} regionPath
 */
export function firstPartyGroup(regionPath) {
  const n = normalizeRegionPath(regionPath) ?? '';
  const seg = n.split('/');
  if (seg.length > 2 && (seg[0] === 'packages' || seg[0] === 'apps')) return `${seg[0]}/${seg[1]}`;
  return seg.length > 1 ? seg[0] : '(root)';
}

/**
 * Map identifier -> string value for simple `const|let|var X = "..."` assignments
 * (also `, X = "..."` continuations in a declaration list).
 * @param {string} code
 */
export function stringConsts(code) {
  /** @type {Map<string,string>} */
  const m = new Map();
  const re = /(?:\b(?:const|let|var)\s+|,\s*)([\w$]+)\s*=\s*(["'`])([^"'`\n\\$]*)\2/g;
  for (const x of code.matchAll(re)) if (!m.has(x[1])) m.set(x[1], x[3]);
  return m;
}

/**
 * Read the first call argument at `idx` and resolve it to a string when possible.
 * @param {string} code
 * @param {number} idx index just after `(`
 * @param {Map<string,string>} consts
 * @returns {{ raw: string, value: string|null }}
 */
export function readArg(code, idx, consts) {
  const rest = code.slice(idx, idx + 300);
  const s = /^\s*(["'`])([^"'`\n]*)\1/.exec(rest);
  if (s) return { raw: s[0].trim(), value: s[2].includes('${') ? null : s[2] };
  // namespaced key helper: x.createKey("name") -> "<namespace>.name"
  const key = /^\s*([\w$]+(?:\.[\w$]+)*)\.createKey\(\s*["']([^"'\n]+)["']\s*\)/.exec(rest);
  if (key) return { raw: key[0].trim(), value: `${consts.get('@namespace') ?? '<namespace>'}.${key[2]}` };
  const id = /^\s*([\w$]+(?:\??\.[\w$]+)*)/.exec(rest);
  if (!id) return { raw: rest.trim().slice(0, 40), value: null };
  const raw = id[1];
  const last = raw.split('.').pop() ?? raw;
  const local = /^[\w$]+$/.test(raw) ? resolveLocal(code, idx, raw, consts) : null;
  // Global by-name lookup only for names that can't be minifier noise (t, n, Ke...).
  const global = (/** @type {string} */ n) => (/^[A-Z][A-Z0-9_]+$/.test(n) || n.length >= 4 ? consts.get(n) : undefined);
  const value = local ?? global(raw) ?? global(last) ?? null;
  return { raw, value: value === '' ? null : value };
}

/**
 * Resolve an identifier from its nearest preceding declaration (within 5000 chars of the call):
 * `const x = "str"` or `const x = fn(...)` with `function fn` returning string constants.
 * @param {string} code
 * @param {number} idx
 * @param {string} name
 * @param {Map<string,string>} consts
 */
export function resolveLocal(code, idx, name, consts) {
  const before = code.slice(Math.max(0, idx - 5000), idx);
  const n = name.replace(/\$/g, '\\$');
  const decls = [...before.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=\\s*(?:(["'])([^"'\\n]*)\\1|([\\w$]+)\\s*\\()`, 'g'))];
  const d = decls.at(-1);
  if (!d) return null;
  if (d[2] !== undefined) return d[2] || null;
  return resolveViaFunction(code, d[3], consts);
}

/**
 * Resolve `const x = fn(...)` where `function fn(){ ... }` returns string constants
 * (e.g. a dev/prod ternary). Returns "a|b" for multiple candidates, or null.
 * @param {string} code
 * @param {string} fnName
 * @param {Map<string,string>} consts
 */
export function resolveViaFunction(code, fnName, consts) {
  if (!/^[\w$]+$/.test(fnName)) return null;
  // Only tiny functions whose whole body is `return <strings/constants, ternaries>`.
  const fn = new RegExp(`\\bfunction\\s+${fnName.replace(/\$/g, '\\$')}\\s*\\([^)]*\\)\\s*\\{\\s*return\\b([^;}]{0,300});?\\s*\\}`).exec(code);
  if (!fn) return null;
  const vals = new Set();
  for (const m of fn[1].matchAll(/["']([^"'\n]+)["']|\b([A-Za-z_$][\w$]*)\b/g)) {
    const v = m[1] ?? consts.get(m[2]);
    if (v) vals.add(v);
  }
  return vals.size && vals.size <= 4 ? [...vals].join('|') : null;
}

/**
 * Text of each `webPreferences: { ... }` object literal (brace-matched, capped).
 * @param {string} code
 */
export function webPreferencesBlocks(code) {
  const out = [];
  for (const m of code.matchAll(/\bwebPreferences\s*:\s*\{/g)) {
    let i = (m.index ?? 0) + m[0].length, depth = 1;
    const end = Math.min(code.length, i + 4000);
    for (; i < end && depth; i++) { const c = code[i]; if (c === '{') depth++; else if (c === '}') depth--; }
    out.push(code.slice((m.index ?? 0) + m[0].length, i - 1));
  }
  return out;
}

/**
 * Wrapper-registered channels: `{ channel: CONST, ... }` objects passed to IPC helpers.
 * Only constants that resolve to a string count.
 * @param {string} code
 * @param {Map<string,string>} consts
 */
export function wrapperChannels(code, consts) {
  const out = new Set();
  for (const m of code.matchAll(/\bchannel\s*:\s*([A-Za-z_$][\w$]*)\b/g)) {
    const v = consts.get(m[1]);
    if (v) out.add(v);
  }
  return [...out];
}

/** @type {[string, RegExp][]} */
const CALLS = [
  ['ipcMain', /\bipcMain\.(handle|handleOnce|on|once|removeHandler)\s*\(/g],
  ['ipcRenderer', /\bipcRenderer\.(invoke|send|sendSync|on|once|postMessage)\s*\(/g],
  ['webContents', /\bwebContents\.(send)\s*\(/g],
  ['contextBridge', /\bcontextBridge\.(exposeInMainWorld)\s*\(/g],
  ['protocol', /\bprotocol\.(handle|registerFileProtocol|registerStringProtocol|registerHttpProtocol|interceptFileProtocol)\s*\(/g],
  ['app', /\b(setAsDefaultProtocolClient)\s*\(/g],
  ['shell', /\bshell\.(openExternal|openPath)\s*\(/g],
];
const FLAGS = /\b(nodeIntegration|nodeIntegrationInWorker|nodeIntegrationInSubFrames|contextIsolation|sandbox|webSecurity|allowRunningInsecureContent|webviewTag|experimentalFeatures|preload)\s*:\s*([^,}\n]{1,100})/g;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>()\\{}[\]^|]+/g;

/**
 * Scan one file. `code` should be comment-stripped; `raw` is the original (for debugId/sourceMappingURL).
 * @param {string} code
 * @param {string} raw
 */
export function scanFile(code, raw = code) {
  const consts = stringConsts(code);
  // namespace for createKey(): literal arg, a defaulted parameter (`namespace = "x"`) or an `ipcNamespace: "x"` option
  const ns = /\bipcChannelUtils\s*\(\s*["']([^"'\n]+)["']/.exec(code)
    ?? /\bnamespace\s*=\s*["']([^"'\n]+)["']/.exec(code)
    ?? /\bipcNamespace\s*:\s*["']([^"'\n]+)["']/.exec(code);
  if (ns) consts.set('@namespace', ns[1]);
  /** @type {{ api: string, method: string, channel: string|null, raw: string }[]} */
  const calls = [];
  for (const [api, re] of CALLS) {
    for (const m of code.matchAll(re)) {
      const a = readArg(code, (m.index ?? 0) + m[0].length, consts);
      calls.push({ api, method: m[1], channel: a.value, raw: a.raw });
    }
  }
  if (/\bipcMain\b/.test(code)) {
    for (const ch of wrapperChannels(code, consts)) calls.push({ api: 'ipcMain', method: 'wrapper', channel: ch, raw: 'channel:' });
  }
  /** @type {string[]} */
  const schemes = [];
  for (const m of code.matchAll(/registerSchemesAsPrivileged\s*\(\s*\[([\s\S]{0,3000}?)\]\s*\)/g)) {
    for (const s of m[1].matchAll(/scheme\s*:\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))/g)) {
      const v = s[1] ?? consts.get(s[2]);
      if (v) schemes.push(v);
    }
  }
  /** @type {{ flag: string, value: string }[]} */
  const flags = [];
  for (const block of webPreferencesBlocks(code)) {
    for (const m of block.matchAll(FLAGS)) flags.push({ flag: m[1], value: m[2].trim().replace(/^!0$/, 'true').replace(/^!1$/, 'false') });
  }
  const urls = new Set();
  for (const m of code.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?'"]+$/, '');
    if (/^[a-z]+:\/\/[\w.-]+/i.test(u)) urls.add(u);
  }
  const env = new Set();
  for (const m of code.matchAll(/\bprocess\.env\.([A-Za-z_]\w*)|\bprocess\.env\[\s*["']([^"']+)["']\s*\]/g)) env.add(m[1] ?? m[2]);
  const debugIds = [...raw.matchAll(/\/\/# debugId=([0-9a-fA-F-]{8,})/g)].map((m) => m[1]);
  const sourceMaps = [...raw.matchAll(/\/\/# sourceMappingURL=(\S+)/g)].map((m) => m[1]).filter((s) => !s.startsWith('data:'));
  return { calls, schemes, flags, urls: [...urls].sort(), env: [...env].sort(), debugIds, sourceMaps };
}

/** Fresh accumulator for map.json. */
export function createMapAcc() {
  return {
    /** @type {Map<string, {name:string, versions:Set<string>, bundledBytes:number, diskBytes:number, files:number, sources:Set<string>}>} */
    packages: new Map(),
    /** @type {Map<string, Set<string>>} */
    firstParty: new Map(),
    /** @type {{ file: string, api: string, method: string, channel: string|null, raw: string }[]} */
    calls: [],
    /** @type {{ file: string, flag: string, value: string }[]} */
    flags: [],
    /** @type {{ file: string, scheme: string }[]} */
    schemes: [],
    /** @type {Map<string, Set<string>>} */
    urls: new Map(),
    /** @type {Map<string, Set<string>>} */
    env: new Map(),
    /** @type {{ file: string, id: string }[]} */
    debugIds: [],
    /** @type {{ file: string, ref: string }[]} */
    sourceMaps: [],
  };
}

/**
 * @param {ReturnType<typeof createMapAcc>} acc
 * @param {string} name
 * @param {string|null} version
 * @param {{ bundledBytes?: number, diskBytes?: number, files?: number, source: string }} add
 */
export function addPackage(acc, name, version, add) {
  let p = acc.packages.get(name);
  if (!p) { p = { name, versions: new Set(), bundledBytes: 0, diskBytes: 0, files: 0, sources: new Set() }; acc.packages.set(name, p); }
  if (version) p.versions.add(version);
  p.bundledBytes += add.bundledBytes ?? 0;
  p.diskBytes += add.diskBytes ?? 0;
  p.files += add.files ?? 0;
  p.sources.add(add.source);
}

/**
 * Record a bundle's regions (packages and first-party modules).
 * @param {ReturnType<typeof createMapAcc>} acc
 * @param {string} file "archive/path"
 * @param {{ path: string, bytes: number }[]} regions
 */
export function addRegions(acc, file, regions) {
  const archive = file.split('/')[0];
  for (const r of regions) {
    if (r.path.includes('\0') || r.path.startsWith('\\0')) continue;
    const pkg = r.path.includes('node_modules/') ? packageFromPath(r.path) : null;
    if (pkg) { addPackage(acc, pkg.name, pkg.version, { bundledBytes: r.bytes, source: 'bundle-region' }); continue; }
    const key = `${archive}:${firstPartyGroup(r.path)}`;
    if (!acc.firstParty.has(key)) acc.firstParty.set(key, new Set());
    acc.firstParty.get(key)?.add(normalizeRegionPath(r.path) ?? r.path);
  }
}

/**
 * @param {ReturnType<typeof createMapAcc>} acc
 * @param {string} file
 * @param {ReturnType<typeof scanFile>} s
 */
export function addScan(acc, file, s) {
  for (const c of s.calls) acc.calls.push({ file, ...c });
  for (const f of s.flags) acc.flags.push({ file, ...f });
  for (const scheme of s.schemes) acc.schemes.push({ file, scheme });
  for (const u of s.urls) { if (!acc.urls.has(u)) acc.urls.set(u, new Set()); acc.urls.get(u)?.add(file); }
  for (const e of s.env) { if (!acc.env.has(e)) acc.env.set(e, new Set()); acc.env.get(e)?.add(file); }
  for (const id of s.debugIds) acc.debugIds.push({ file, id });
  for (const ref of s.sourceMaps) acc.sourceMaps.push({ file, ref });
}

/** @param {string} u */
function hostOf(u) {
  try { return new URL(u).host || '(none)'; } catch { return '(invalid)'; }
}

/**
 * Turn the accumulator into a JSON-serializable, deterministically sorted map.
 * @param {ReturnType<typeof createMapAcc>} acc
 */
export function finalizeMap(acc) {
  const byName = (/** @type {any} */ a, /** @type {any} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  const packages = [...acc.packages.values()]
    .map((p) => ({ name: p.name, versions: [...p.versions].sort(), id: `${p.name}@${[...p.versions].sort().join('|') || '?'}`, bundledBytes: p.bundledBytes, diskBytes: p.diskBytes, files: p.files, sources: [...p.sources].sort() }))
    .sort((a, b) => byName(a.name, b.name));
  const firstParty = Object.fromEntries([...acc.firstParty.keys()].sort().map((k) => [k, [...(acc.firstParty.get(k) ?? [])].sort()]));
  const sortBy = (/** @type {any[]} */ arr, /** @type {string[]} */ keys) => arr.sort((a, b) => { for (const k of keys) { const c = byName(String(a[k]), String(b[k])); if (c) return c; } return 0; });
  const calls = sortBy(acc.calls, ['api', 'method', 'channel', 'file', 'raw']);
  /** @type {Record<string, Set<string>>} */
  const channels = {};
  /** @type {{ file: string, via: string, arg: string }[]} */
  const dynamicIpc = [];
  for (const c of calls) {
    if (!['ipcMain', 'ipcRenderer', 'webContents'].includes(c.api)) continue;
    if (c.channel == null) { dynamicIpc.push({ file: c.file, via: `${c.api}.${c.method}`, arg: c.raw }); continue; }
    (channels[c.channel] ??= new Set()).add(`${c.api}.${c.method}`);
  }
  /** @type {Record<string, {url: string, files: string[]}[]>} */
  const hosts = {};
  for (const u of [...acc.urls.keys()].sort()) (hosts[hostOf(u)] ??= []).push({ url: u, files: [...(acc.urls.get(u) ?? [])].sort() });
  const sortedHosts = Object.fromEntries(Object.keys(hosts).sort().map((h) => [h, hosts[h]]));
  return {
    packages,
    firstParty,
    electron: {
      ipcChannels: Object.fromEntries(Object.keys(channels).sort().map((k) => [k, [...channels[k]].sort()])),
      dynamicIpc,
      calls,
      exposeInMainWorld: [...new Set(calls.filter((c) => c.api === 'contextBridge').map((c) => c.channel ?? c.raw))].sort(),
      webPreferences: sortBy(acc.flags, ['flag', 'value', 'file']),
      protocols: {
        privilegedSchemes: [...new Set(acc.schemes.map((s) => s.scheme))].sort(),
        handlers: calls.filter((c) => c.api === 'protocol').map((c) => ({ method: c.method, scheme: c.channel ?? c.raw, file: c.file })),
        // resolved scheme names; fall back to the raw argument only when nothing resolved
        defaultProtocolClient: (() => {
          const app = calls.filter((c) => c.api === 'app');
          const resolved = app.filter((c) => c.channel).map((c) => /** @type {string} */ (c.channel));
          return [...new Set(resolved.length ? resolved : app.map((c) => c.raw))].sort();
        })(),
      },
      openExternal: calls.filter((c) => c.api === 'shell').map((c) => ({ method: c.method, arg: c.channel ?? c.raw, file: c.file })),
    },
    network: { urlCount: acc.urls.size, hosts: sortedHosts },
    env: Object.fromEntries([...acc.env.keys()].sort().map((k) => [k, [...(acc.env.get(k) ?? [])].sort()])),
    debugIds: sortBy(acc.debugIds, ['file', 'id']),
    sourceMaps: sortBy(acc.sourceMaps, ['file', 'ref']),
  };
}
