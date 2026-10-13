// @ts-check
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addPackage, addRegions, addScan, createMapAcc, finalizeMap, packageFromPath, scanFile } from './lib/map.mjs';
import { classify, extractImports, isJsFile, isMinified, isThirdParty, normalizeRegionPath, splitRegions, stripComments } from './lib/regions.mjs';
import { buildReport } from './lib/report.mjs';

const BASE_LIMITS = [
  'Recovered region files keep the original extension (.ts, .tsx, ...) but contain the compiled JS that rolldown emitted, not the original source; types and comments stripped by the build are gone.',
  'Source maps are referenced but not shipped, so exact original source cannot be reconstructed.',
  'Imports, IPC channels, URLs, env vars and webPreferences are regex/scan-based best effort: channel/scheme names are traced through string constants, namespaced createKey() helpers, `{ channel: CONST }` registrations and tiny return-a-constant functions; anything computed beyond that is listed as a runtime call site, not guessed.',
  'Callable surface (HTTP routes, RPC method tables, contextBridge members, sender checks, native addons) is scanned with regexes and brace matching on compiled JS: routes built entirely at runtime, RPCs not declared in a `*_METHODS` table or a `method: "a/b"` literal, and bridge objects that are not object literals are missed; outbound calls include bundled third-party clients (e.g. a generated SDK) and say nothing about which calls run.',
  'node_modules/ inside the archives is third-party: counted and package.json-read only, not indexed, recovered or beautified (their `.node` binaries are listed under native addons).',
  'Deobfuscation is best-effort and never proves original source.',
];
const EXT = { wasm: 'wasm', png: 'png', gzip: 'gz', zip: 'zip', pdf: 'pdf', unknown: 'bin' };

/** @param {string} name */
async function loadTransform(name) {
  try { return await import(`./lib/${name}.mjs`); } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/** @param {string} dir @returns {AsyncGenerator<string>} posix relative paths, sorted */
async function* walk(dir, rel = '') {
  const ents = (await readdir(join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile()) yield r;
  }
}

/** @param {string} p @param {string|Buffer} data */
async function put(p, data) { await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); }

export default {
  name: '03-js',
  /** @param {{ inDir: string|null, outDir: string, log: (m: string) => void }} ctx */
  async run({ inDir, outDir, log }) {
    if (!inDir) throw new Error('03-js: no input folder (expected out/02-asar from stage 02)');
    const ents = await readdir(inDir, { withFileTypes: true }).catch(() => null);
    const archives = (ents ?? []).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (!archives.length) throw new Error(`03-js: input folder ${inDir} is missing or has no archive folders; run stage 02-asar first`);

    const t0 = Date.now();
    const limits = [...BASE_LIMITS];
    const bt = await loadTransform('beautify');
    const dt = await loadTransform('deobfuscate');
    if (!bt) limits.push('lib/beautify.mjs missing: beautify step skipped, beautified/ not produced.');
    else limits.push(...(bt.LIMITS ?? []));
    if (!dt) limits.push('lib/deobfuscate.mjs missing: deobfuscation and embedded-blob detection skipped.');
    else limits.push(...(dt.LIMITS ?? []));

    for (const d of ['recovered', 'beautified', 'embedded']) await rm(join(outDir, d), { recursive: true, force: true });
    const acc = createMapAcc();
    /** @type {any[]} */
    const files = [];
    /** @type {Record<string, any>} */
    const archStats = {};
    /** @type {{file:string, from:string, kind:string, bytes:number}[]} */
    const embedded = [];
    let recovered = 0, beautified = 0, rejected = 0;
    const embedNames = new Set();

    for (const archive of archives) {
      const root = join(inDir, archive);
      const st = archStats[archive] = { files: 0, bytes: 0, jsFiles: 0, thirdPartyFiles: 0, thirdPartyBytes: 0 };
      /** @type {Map<string, {name:string, version:string|null}>} */
      const pkgDirs = new Map();
      /** @type {Map<string, {bytes:number, files:number}>} */
      const pkgSize = new Map();
      for await (const rel of walk(root)) {
        const abs = join(root, rel);
        const size = (await stat(abs)).size;
        st.files++; st.bytes += size;
        if (rel.endsWith('.node')) acc.addonFiles.push({ archive, path: rel, package: packageFromPath(rel)?.name ?? null, bytes: size });
        if (isThirdParty(rel)) {
          st.thirdPartyFiles++; st.thirdPartyBytes += size;
          const pdir = /^(.*node_modules\/(?:@[^/]+\/[^/]+|[^@./][^/]*))\//.exec(rel)?.[1];
          if (pdir) {
            const s = pkgSize.get(pdir) ?? { bytes: 0, files: 0 };
            s.bytes += size; s.files++; pkgSize.set(pdir, s);
            if (rel === `${pdir}/package.json`) {
              try { const j = JSON.parse(await readFile(abs, 'utf8')); if (typeof j.name === 'string') pkgDirs.set(pdir, { name: j.name, version: typeof j.version === 'string' ? j.version : null }); } catch { /* unreadable package.json */ }
            }
          }
          continue;
        }
        if (!isJsFile(rel)) continue;
        st.jsFiles++;
        const buf = await readFile(abs);
        const src = buf.toString('utf8');
        const id = `${archive}/${rel}`;
        const { regions, unregioned } = splitRegions(src);
        const minified = isMinified(src);
        const code = stripComments(src);
        const entry = {
          archive, path: rel, size, sha256: createHash('sha256').update(buf).digest('hex'),
          kind: classify(rel, { regions: regions.length }), minified, regions: regions.length,
          imports: extractImports(code), changes: null, signals: null,
        };
        if (regions.length) {
          for (const r of regions) {
            const np = normalizeRegionPath(r.path);
            if (!np) { rejected++; continue; }
            await put(join(outDir, 'recovered', archive, rel, ...np.split('/')), r.code);
            recovered++;
          }
          if (unregioned.trim()) await put(join(outDir, 'recovered', archive, rel, '_unregioned.js'), unregioned);
          addRegions(acc, id, regions.map((r) => ({ path: r.path, bytes: Buffer.byteLength(r.code) })));
        }
        acc.imports.set(id, entry.imports);
        addScan(acc, id, scanFile(code, src), entry.kind);
        let deob = src;
        if (dt) {
          try {
            const res = dt.deobfuscate(src);
            deob = res.code;
            entry.changes = res.changes;
            const { embedded: emb = [], ...rest } = res.signals ?? {};
            entry.signals = { ...rest, embedded: emb.length };
            let n = 0;
            for (const e of emb) {
              const data = Buffer.from(src.slice(e.start, e.end), 'base64');
              let name = `${rel.split('/').pop()}.${n++}.${EXT[e.kind] ?? 'bin'}`;
              while (embedNames.has(name)) name = `${archive}.${name}`;
              embedNames.add(name);
              await put(join(outDir, 'embedded', name), data);
              embedded.push({ file: name, from: id, kind: e.kind, bytes: data.length });
            }
          } catch (err) { entry.signals = { error: String(/** @type {any} */ (err)?.message ?? err) }; }
        }
        if (minified && bt) {
          try { await put(join(outDir, 'beautified', archive, ...rel.split('/')), bt.beautify(deob)); beautified++; } catch (err) {
            entry.signals = { ...(entry.signals ?? {}), beautifyError: String(/** @type {any} */ (err)?.message ?? err) };
          }
        }
        files.push(entry);
      }
      for (const [pdir, info] of [...pkgDirs].sort()) {
        const s = pkgSize.get(pdir) ?? { bytes: 0, files: 0 };
        addPackage(acc, info.name, info.version, { diskBytes: s.bytes, files: s.files, source: `${archive}:node_modules` });
      }
      log(`03-js: ${archive}: ${st.files} files, ${st.jsFiles} first-party JS`);
    }

    const map = finalizeMap(acc);
    if (rejected) limits.push(`${rejected} region path(s) rejected as unsafe (escaping the output folder) and not written.`);
    const transforms = { beautify: !!bt, deobfuscate: !!dt };
    await writeFile(join(outDir, 'index.json'), JSON.stringify({ archives: archStats, transforms, files }, null, 2) + '\n');
    await writeFile(join(outDir, 'map.json'), JSON.stringify(map, null, 2) + '\n');
    await writeFile(join(outDir, 'REPORT.md'), buildReport({ files, archives: archStats, recovered, beautified, embedded, transforms }, map, limits));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      status: 'ok',
      inputs: [inDir],
      outputs: ['index.json', 'map.json', 'REPORT.md', ...embedded.map((e) => `embedded/${e.file}`)],
      notes: [
        `${files.length} first-party JS files indexed across ${archives.length} archive(s) in ${secs}s`,
        `${recovered} region modules written to recovered/, ${beautified} minified files to beautified/, ${embedded.length} embedded blob(s)`,
        `${map.packages.length} packages, ${Object.keys(map.electron.ipcChannels).length} IPC channels, ${map.network.urlCount} URLs`,
        `surface: ${map.surface.routes.length} HTTP routes, ${map.surface.rpcTables.reduce((n, t) => n + t.methods.length, 0)} RPC methods in ${map.surface.rpcTables.length} table(s), ${Object.keys(map.surface.jsonRpc).length} JSON-RPC methods, ${map.surface.bridges.reduce((n, b) => n + b.members.length, 0)} bridge members, ${map.surface.senderChecks.reduce((n, c) => n + c.count, 0)} sender checks, ${map.surface.nativeAddons.files.length} native addon file(s)`,
      ],
      limits,
    };
  },
};
