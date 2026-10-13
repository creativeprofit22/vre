// @ts-check
// Pure: build REPORT.md text from the index summary and the finalized map.

const kb = (/** @type {number} */ n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const esc = (/** @type {string} */ s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const short = (/** @type {string} */ f) => f.split('/').pop() ?? f;

/**
 * Report lines for the callable surface: HTTP routes, RPC tables, bridge members, sender checks, native addons.
 * @param {ReturnType<typeof import('./map.mjs').finalizeMap>['surface']} s
 */
export function surfaceSection(s) {
  const L = ['## Callable surface', ''];
  const serve = s.routes.filter((r) => r.kind === 'serve');
  const pages = s.routes.filter((r) => r.kind === 'page');
  const calls = s.routes.filter((r) => r.kind === 'call');
  L.push(`### HTTP endpoints served (${serve.length})`, '', 'Router registrations, MCP/HTTP layers and request-URL checks inside local HTTP handlers.', '');
  if (serve.length) {
    L.push('| method | path | found via | files |', '|---|---|---|---|');
    for (const r of serve) L.push(`| ${r.method} | \`${esc(r.path)}\` | ${r.via.join(', ')} | ${r.files.map(short).join(', ')} |`);
  } else L.push('None found.');
  if (pages.length) L.push('', `Client-side page routes checked in browser chunks: ${pages.map((r) => `\`${esc(r.path)}\``).join(', ')}`);
  L.push('', `### Outbound HTTP API calls (${calls.length})`, '', 'Request objects, generated API clients, socket requests and versioned paths appended to a base URL. Grouped by first path segment; the full list is in `map.json` (`surface.routes`).', '');
  /** @type {Map<string, typeof calls>} */
  const groups = new Map();
  for (const r of calls) { const g = `/${r.path.split('/')[1] ?? ''}`; groups.set(g, [...(groups.get(g) ?? []), r]); }
  if (groups.size) {
    L.push('| prefix | calls | paths (method path) | files |', '|---|---|---|---|');
    for (const [g, rs] of [...groups].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
      const shown = rs.slice(0, 12).map((r) => `${r.method} ${r.path}`).join(', ');
      const files = [...new Set(rs.flatMap((r) => r.files.map(short)))].join(', ');
      L.push(`| \`${esc(g)}\` | ${rs.length} | ${esc(shown)}${rs.length > 12 ? ', ...' : ''} | ${esc(files)} |`);
    }
  } else L.push('None found.');

  L.push('', `### RPC method tables (${s.rpcTables.length})`, '', 'Constant tables of method names (`const *_METHODS = {...}`), with spreads of other tables expanded.', '');
  if (s.rpcTables.length) {
    L.push('| table | methods | includes | files |', '|---|---|---|---|');
    for (const t of s.rpcTables) L.push(`| ${t.name} | ${t.methods.length} | ${t.includes.join(', ') || '-'} | ${t.files.map(short).join(', ')} |`);
    for (const t of s.rpcTables) {
      /** @type {Record<string, string[]>} */
      const ns = {};
      for (const m of t.methods) { const k = m.split(/[./]/)[0]; (ns[k] ??= []).push(m.slice(k.length + 1)); }
      L.push('', `**${t.name}** by namespace:`, '');
      for (const [k, v] of Object.entries(ns).sort()) L.push(`- \`${esc(k)}\` (${v.length}): ${v.map(esc).join(', ')}`);
    }
  } else L.push('None found.');
  const rpc = Object.keys(s.jsonRpc);
  L.push('', `### JSON-RPC methods (${rpc.length})`, '', '`method: "a/b"` literals (agent/app-server and MCP protocol messages).', '');
  /** @type {Record<string, number>} */
  const roots = {};
  for (const m of rpc) roots[m.split('/')[0]] = (roots[m.split('/')[0]] ?? 0) + 1;
  L.push(Object.entries(roots).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `\`${esc(k)}/*\` ${n}`).join(', ') || 'None found.');

  L.push('', '### contextBridge APIs', '');
  for (const b of s.bridges) {
    const linked = b.members.filter((m) => m.channels.length).length;
    L.push(`**window.${esc(b.api)}** (${short(b.file)}): ${b.members.length} member(s), ${linked} mapped to IPC channels.`, '');
    if (b.members.length) {
      L.push('| member | IPC channel(s) |', '|---|---|');
      for (const m of b.members) L.push(`| \`${esc(m.path)}\` | ${m.channels.map((c) => `\`${esc(c)}\``).join(', ') || '-'} |`);
      L.push('');
    } else L.push('Members not resolvable statically (value is not an object literal).', '');
  }
  if (!s.bridges.length) L.push('None found.', '');

  L.push('### IPC sender checks', '', 'Places where the main process checks who sent a message (observations only; they do not prove complete coverage).', '');
  if (s.senderChecks.length) {
    L.push('| file | kind | check | count |', '|---|---|---|---|');
    for (const c of s.senderChecks) L.push(`| ${short(c.file)} | ${c.kind} | \`${esc(c.name)}\` | ${c.count} |`);
  } else L.push('None found.');

  const na = s.nativeAddons;
  L.push('', `### Native addons (${na.files.length} .node file(s))`, '', 'Shipped `.node` binaries, the package that loads them, and the first-party bundles importing that package. Analysed as binaries in stage 04-native.', '');
  if (na.files.length) {
    L.push('| archive | file | package | loader | imported by |', '|---|---|---|---|---|');
    for (const a of na.files) L.push(`| ${a.archive} | ${esc(a.path)} | ${esc(a.package ?? '?')} | ${esc(a.loader ?? '?')} | ${a.importedBy.map(short).join(', ') || 'no direct first-party import (loaded by another package)'} |`);
  } else L.push('None found.');
  if (na.loads.length) L.push('', `Direct loads in first-party code: ${na.loads.map((l) => `${short(l.file)} (${[...l.requires, ...(l.dlopen ? [`process.dlopen x${l.dlopen}`] : [])].join(', ')})`).join('; ')}`);
  L.push('');
  return L;
}

/**
 * @param {{ files: any[], archives: Record<string, {files:number, bytes:number, jsFiles:number, thirdPartyFiles:number, thirdPartyBytes:number}>,
 *   recovered: number, beautified: number, embedded: {file:string, from:string, kind:string, bytes:number}[], transforms: {beautify:boolean, deobfuscate:boolean} }} sum
 * @param {ReturnType<typeof import('./map.mjs').finalizeMap>} map
 * @param {string[]} limits
 */
export function buildReport(sum, map, limits) {
  const L = [];
  const files = sum.files;
  /** @type {Record<string, number>} */
  const byKind = {};
  for (const f of files) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  L.push('# Voyager (design.moda.voyager): JavaScript reverse-engineering report', '');
  L.push('Generated by stage `03-js` from `out/02-asar/`. Everything here is derived by regex/scan heuristics from the shipped bundles; treat it as evidence, not proof.', '');
  L.push('## Overview', '', '| archive | files | size | first-party JS | third-party (node_modules) files | third-party size |', '|---|---|---|---|---|---|');
  for (const [a, s] of Object.entries(sum.archives)) L.push(`| ${a} | ${s.files} | ${kb(s.bytes)} | ${s.jsFiles} | ${s.thirdPartyFiles} | ${kb(s.thirdPartyBytes)} |`);
  L.push('', `- JS files indexed: ${files.length} (${Object.entries(byKind).sort().map(([k, v]) => `${k}: ${v}`).join(', ')})`);
  L.push(`- minified: ${files.filter((f) => f.minified).length}; recovered region modules: ${sum.recovered}; beautified files: ${sum.beautified}; embedded blobs: ${sum.embedded.length}`);
  L.push(`- regions in bundles: ${files.reduce((n, f) => n + f.regions, 0)}`, '');

  L.push('## Architecture', '');
  const big = [...files].filter((f) => f.kind !== 'browser-chunk').sort((a, b) => b.size - a.size).slice(0, 12);
  L.push('Largest non-browser bundles:', '', '| file | kind | size | regions | imports |', '|---|---|---|---|---|');
  for (const f of big) L.push(`| ${esc(`${f.archive}/${f.path}`)} | ${f.kind} | ${kb(f.size)} | ${f.regions} | ${f.imports.length} |`);
  const preloads = files.filter((f) => f.kind === 'preload');
  const chunks = files.filter((f) => f.kind === 'browser-chunk');
  L.push('', `- Desktop (Electron main + preloads): ${preloads.length} preload script(s): ${preloads.map((f) => `\`${f.path.split('/').pop()}\``).join(', ') || 'none'}.`);
  L.push(`- Browser/web client: ${chunks.length} chunk(s), ${kb(chunks.reduce((n, f) => n + f.size, 0))}, ${chunks.filter((f) => f.minified).length} minified.`);
  const localHosts = Object.keys(map.network.hosts).filter((h) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(h));
  L.push(`- Local endpoints referenced (desktop <-> server link candidates): ${localHosts.join(', ') || 'none found'}.`);
  const builtins = new Set();
  for (const f of files) for (const i of f.imports) if (/^(node:|electron$)/.test(i)) builtins.add(i);
  L.push(`- Node/Electron modules imported: ${[...builtins].sort().map((b) => `\`${b}\``).join(', ') || 'none'}.`, '');

  L.push('## First-party module tree', '', '| archive:group | modules |', '|---|---|');
  for (const [g, mods] of Object.entries(map.firstParty)) L.push(`| ${esc(g)} | ${mods.length} |`);
  L.push('');

  L.push('## Electron security posture', '', '### webPreferences flags', '');
  if (!map.electron.webPreferences.length) L.push('None found.');
  else {
    const rows = new Map();
    for (const f of map.electron.webPreferences) { const k = `${f.flag} | \`${esc(f.value)}\` | ${esc(f.file)}`; rows.set(k, (rows.get(k) ?? 0) + 1); }
    L.push('| flag | value | file | occurrences |', '|---|---|---|---|');
    for (const [k, n] of rows) L.push(`| ${k} | ${n} |`);
  }
  L.push('', `- contextBridge.exposeInMainWorld: ${map.electron.exposeInMainWorld.map((s) => `\`${s}\``).join(', ') || 'none'}`);
  L.push(`- privileged schemes: ${map.electron.protocols.privilegedSchemes.join(', ') || 'none'}; protocol handlers: ${map.electron.protocols.handlers.map((h) => `${h.method}(${h.scheme})`).join(', ') || 'none'}; default protocol client: ${map.electron.protocols.defaultProtocolClient.join(', ') || 'none'}`);
  L.push(`- shell.openExternal/openPath call sites: ${map.electron.openExternal.length}`, '');
  const ch = Object.entries(map.electron.ipcChannels);
  L.push(`### IPC channels (${ch.length})`, '', '| channel | used via |', '|---|---|');
  for (const [c, v] of ch) L.push(`| \`${esc(c)}\` | ${v.join(', ')} |`);
  const dyn = map.electron.dynamicIpc ?? [];
  if (dyn.length) {
    L.push('', `${dyn.length} call site(s) pass a channel computed at runtime (generic helpers such as an IPC registry taking \`channel\` as a parameter; the concrete names they carry are listed above when they could be traced to constants):`, '');
    const g = new Map();
    for (const d of dyn) { const k = `${d.file} | ${d.via}(${d.arg})`; g.set(k, (g.get(k) ?? 0) + 1); }
    for (const [k, n] of g) L.push(`- ${esc(k)}${n > 1 ? ` x${n}` : ''}`);
  }
  L.push('');

  if (map.surface) L.push(...surfaceSection(map.surface));

  const hosts = Object.entries(map.network.hosts).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  L.push('## Network endpoints', '', `${map.network.urlCount} unique URLs across ${hosts.length} hosts (first-party code only). Top hosts:`, '', '| host | urls | example |', '|---|---|---|');
  for (const [h, us] of hosts.slice(0, 40)) L.push(`| ${esc(h)} | ${us.length} | ${esc(us[0].url.slice(0, 100))} |`);
  const env = Object.keys(map.env);
  L.push('', `process.env variables (${env.length}): ${env.slice(0, 150).map((e) => `\`${e}\``).join(', ')}${env.length > 150 ? ', ...' : ''}`, '');

  const pk = [...map.packages].sort((a, b) => (b.bundledBytes + b.diskBytes) - (a.bundledBytes + a.diskBytes) || (a.name < b.name ? -1 : 1));
  L.push('## Third-party packages', '', `${pk.length} packages total (bundled into regions or shipped in node_modules). Top 30 by size:`, '', '| package | bundled | on disk | source |', '|---|---|---|---|');
  for (const p of pk.slice(0, 30)) L.push(`| ${esc(p.id)} | ${kb(p.bundledBytes)} | ${kb(p.diskBytes)} | ${p.sources.join(', ')} |`);
  L.push('');

  L.push('## Embedded binaries', '');
  if (!sum.embedded.length) L.push(sum.transforms.deobfuscate ? 'None detected.' : 'Not scanned (deobfuscate transform unavailable).');
  else { L.push('| file | from | kind | size |', '|---|---|---|---|'); for (const e of sum.embedded) L.push(`| embedded/${esc(e.file)} | ${esc(e.from)} | ${e.kind} | ${kb(e.bytes)} |`); }
  L.push('');

  L.push('## Obfuscation verdict', '');
  const changed = files.filter((f) => f.changes && Object.values(f.changes).some((n) => Number(n) > 0));
  /** @type {Record<string, number>} */
  const totals = {};
  for (const f of files) for (const [k, v] of Object.entries(f.changes ?? {})) totals[k] = (totals[k] ?? 0) + Number(v);
  const regioned = files.filter((f) => f.regions > 0).length;
  L.push(`- ${regioned} bundle(s) keep rolldown \`//#region\` markers with original source paths, and ${map.debugIds.length} Sentry debugId(s) / ${map.sourceMaps.length} sourceMappingURL reference(s) (maps not shipped).`);
  L.push(`- Minified files: ${files.filter((f) => f.minified).length} of ${files.length} (browser chunks are Vite-minified; minification is not obfuscation).`);
  if (!sum.transforms.deobfuscate) L.push('- Deobfuscation transform unavailable: no obfuscation rules were applied.');
  else L.push(`- Deobfuscation rule hits: ${Object.entries(totals).sort().map(([k, v]) => `${k}=${v}`).join(', ') || 'none'} across ${changed.length} file(s).`);
  // !0/!1/void 0 rewrites are standard minifier idioms, not obfuscation
  const MINIFIER_RULES = new Set(['notOneToFalse', 'notZeroToTrue', 'voidZeroToUndefined']);
  const obf = files.filter((f) => Object.entries(f.changes ?? {}).some(([k, n]) => !MINIFIER_RULES.has(k) && Number(n) > 0));
  if (sum.transforms.deobfuscate) L.push(`- Hits from rules other than minifier idioms (\`!0\`, \`!1\`, \`void 0\`): ${obf.length} file(s).`);
  const verdict = regioned > 0 && obf.length <= files.length * 0.05 ? 'Not obfuscated: readable bundler output with preserved module paths; only the web client is minified.' : 'Inconclusive: review rule hits above.';
  L.push(`- **Verdict:** ${verdict}`, '');

  L.push('## Limits', '', ...limits.map((l) => `- ${l}`), '');
  return L.join('\n');
}
