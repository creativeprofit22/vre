// Stage 04: static analysis of the native binaries (PE files and Node native modules) shipped with the app.
// Reads the OUTPUT folders of stages 01 and 02 (siblings of this stage's outDir); never imports them.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { capabilities, certNames, entropyFromCounts, isPE, PACKED_ENTROPY, parsePE, StringScanner, toolchains } from './lib/pe.mjs';
import { BUN_TRAILER, parseBunGraph, rustSources, safeModulePath } from './lib/embedded.mjs';
import { buildReport } from './lib/report.mjs';

const LIMITS = [
  'Static analysis only: headers, imports/exports, resources, entropy and strings. No disassembly, decompilation or execution.',
  'Authenticode: only presence and certificate subject names are read; the signature is NOT cryptographically verified.',
  'Signer is a heuristic (first certificate CN that is not a CA / timestamp authority).',
  'Voyager.exe is the Electron/Chromium host: its imports and strings mostly describe Chromium, not Voyager logic (that lives in the JS, see 03-js).',
  'Capabilities are inferred from imported API names; dynamically resolved APIs (GetProcAddress) are invisible.',
  'Strings are capped per category and file; only "interesting" categories are kept.',
  'Bun standalone module graphs are parsed from the documented trailer layout (Bun 1.1-1.3); embedded JS is extracted as-is (minified, no bytecode decompilation).',
  'Rust provenance comes from build paths left in panic/debug strings: it lists crates and source files that were compiled in, not what runs, and misses code without such strings.',
];

const CHUNK = 4 << 20;

async function walk(dir, out = []) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const posix = (p) => p.split(sep).join('/');

/** Classify a binary by where it lives. */
export function roleOf(path) {
  const p = path.toLowerCase();
  const name = basename(p);
  if (p.endsWith('.node')) return 'native-module';
  if (/^app\/[^/]+\.exe$/.test(p)) return name.startsWith('uninstall') ? 'installer-helper' : 'electron-host';
  if (/^nsis\//.test(p)) return 'installer-helper';
  if (name === 'elevate.exe') return 'installer-helper';
  if (name.startsWith('voyager-')) return 'voyager-helper';
  if (/\/resources\/(engines|voyager)\//.test(p)) return 'bundled-tool';
  if (/^app\/[^/]+\.dll$/.test(p)) return 'electron-runtime';
  return 'other';
}

/** One pass over the file: sha256, per-section byte histograms, strings. */
function scanFile(fd, size, sections) {
  const hash = createHash('sha256');
  const hist = sections.map(() => new Uint32Array(256));
  const strings = new StringScanner();
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let pos = 0; pos < size;) {
    const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
    if (n <= 0) break;
    const chunk = buf.subarray(0, n);
    hash.update(chunk);
    strings.feed(chunk);
    sections.forEach((s, i) => {
      const a = Math.max(pos, s.rawPtr), b = Math.min(pos + n, s.rawPtr + s.rawSize);
      const h = hist[i];
      for (let j = a - pos; j < b - pos; j++) h[chunk[j]]++;
    });
    pos += n;
  }
  return { sha256: hash.digest('hex'), hist, strings: strings.finish() };
}

/** Analyse one PE file (path is absolute). */
export function analyse(abs, size) {
  const fd = openSync(abs, 'r');
  try {
    const io = { size, read: (off, len) => { const b = Buffer.alloc(Math.max(0, Math.min(len, size - off))); if (b.length) readSync(fd, b, 0, b.length, off); return b; } };
    const pe = parsePE(io);
    const scan = scanFile(fd, size, pe.sections);
    pe.sections.forEach((s, i) => {
      s.entropy = Number(entropyFromCounts(scan.hist[i], Math.min(s.rawSize, Math.max(0, size - s.rawPtr))).toFixed(3));
      s.packed = s.entropy > PACKED_ENTROPY && s.flags.includes('exec');
    });
    let signature = null;
    if (pe.security && pe.security.offset + pe.security.size <= size) {
      const blob = io.read(pe.security.offset, Math.min(pe.security.size, 1 << 20));
      signature = { size: pe.security.size, ...certNames(blob) };
    }
    const all = [...pe.imports, ...pe.delayImports];
    return {
      sha256: scan.sha256,
      ...pe,
      signature,
      capabilities: capabilities(all),
      importCount: all.reduce((n, d) => n + d.functions.length, 0),
      toolchains: toolchains(scan.strings.interesting.toolchain ?? [], pe.pdb),
      strings: scan.strings,
      packedSections: pe.sections.filter((s) => s.packed).map((s) => s.name),
    };
  } finally { closeSync(fd); }
}

async function readHead(abs, n = 1024) {
  const fd = openSync(abs, 'r');
  try { const b = Buffer.alloc(n); const r = readSync(fd, b, 0, n, 0); return b.subarray(0, r); } finally { closeSync(fd); }
}

async function readSlice(abs, off, len) {
  const fd = openSync(abs, 'r');
  try { const b = Buffer.alloc(Math.max(0, len)); const n = len > 0 ? readSync(fd, b, 0, len, off) : 0; return b.subarray(0, n); } finally { closeSync(fd); }
}

async function engines(appDir) {
  const res = { manifest: null, tools: [] };
  try { res.manifest = JSON.parse(await readFile(join(appDir, 'resources', 'engines', 'engines-manifest.json'), 'utf8')); } catch { /* optional */ }
  try { res.tools = (await readdir(join(appDir, 'resources', 'voyager', 'native'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* optional */ }
  return res;
}

export default {
  name: '04-native',
  async run({ outDir, manifest, log }) {
    const outRoot = dirname(outDir);
    const instDir = join(outRoot, '01-installer');
    const appDir = join(instDir, 'app');
    const asarDir = join(outRoot, '02-asar');
    if (!(await stat(appDir).catch(() => null))?.isDirectory()) throw new Error(`04-native needs stage 01 output at ${appDir}; run 01-installer first`);
    const notes = [];
    const e01 = manifest?.entries?.find((e) => e.stage === '01-installer');
    if (e01 && e01.status !== 'ok') notes.push(`warning: 01-installer manifest status is ${e01.status}`);

    const files = [...await walk(instDir), ...await walk(asarDir)];
    /** @type {Map<string, any>} */
    const bySha = new Map();
    const records = [];
    let scanned = 0, skipped = 0;
    const t0 = Date.now();
    for (const abs of files) {
      const st = await stat(abs);
      if (st.size < 512) continue;
      const head = await readHead(abs);
      if (!isPE(head)) { skipped++; continue; }
      const root = abs.startsWith(asarDir) ? asarDir : instDir;
      const rel = `${root === asarDir ? '02-asar' : '01-installer'}/${posix(relative(root, abs))}`;
      const path = posix(relative(root, abs));
      scanned++;
      let rec;
      try { rec = analyse(abs, st.size); } catch (e) {
        records.push({ path: rel, size: st.size, role: roleOf(path), error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const prior = bySha.get(rec.sha256);
      if (prior) { prior.copies.push(rel); continue; }
      const full = { path: rel, size: st.size, role: roleOf(path), copies: [], ...rec };
      bySha.set(rec.sha256, full);
      records.push(full);
    }
    // Embedded payloads: Bun standalone graphs (extracted) and Rust build provenance
    const embDir = join(outDir, 'embedded');
    await rm(embDir, { recursive: true, force: true });
    let bunApps = 0, bunFiles = 0, rustBins = 0;
    for (const r of records) {
      if (r.error) continue;
      const abs = join(outRoot, ...r.path.split('/'));
      const bunSec = r.sections?.find((x) => x.name === '.bun');
      if (bunSec || (r.overlay && r.overlay > 0 && !r.overlayIsSignature)) {
        const buf = bunSec ? await readSlice(abs, bunSec.rawPtr, bunSec.rawSize) : await readSlice(abs, r.sectionEnd ?? 0, r.size - (r.sectionEnd ?? 0));
        const g = buf.lastIndexOf(BUN_TRAILER) >= 0 ? parseBunGraph(buf) : null;
        if (g) {
          const dest = join(embDir, `${basename(r.path).replace(/\.[^.]+$/, '')}-${r.sha256.slice(0, 8)}`);
          let written = 0;
          for (const m of g.modules) {
            const rel = safeModulePath(m.path.replace(/^(\.\.\/)+/, '_up/'));
            if (!rel) continue;
            const out = join(dest, ...rel.split('/'));
            await mkdir(dirname(out), { recursive: true });
            await writeFile(out, buf.subarray(m.offset, m.offset + m.size));
            written++;
          }
          const ua = /--user-agent=(\S+)/.exec(g.execArgv)?.[1] ?? null;
          r.bun = { entryPoint: g.entryPoint, execArgv: g.execArgv, userAgent: ua, recordSize: g.recordSize, bytes: g.byteCount,
            extractedTo: posix(relative(outDir, dest)), modules: g.modules.map((m) => ({ path: m.path, size: m.size, sourcemapBytes: m.sourcemapBytes, bytecodeBytes: m.bytecodeBytes })) };
          bunApps++; bunFiles += written;
        }
      }
      if (r.toolchains?.some((t) => /rust/i.test(t))) {
        const rs = rustSources((await readFile(abs)).toString('latin1'));
        r.rust = { ...rs, sourceCount: rs.sources.length, sources: rs.sources.slice(0, 400) };
        rustBins++;
      }
    }
    log(`04-native: ${scanned} PE files, ${records.length} unique, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const eng = await engines(appDir);
    const index = { binaries: records, engines: eng };
    await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    await writeFile(join(outDir, 'REPORT.md'), buildReport(index, LIMITS));
    const signed = records.filter((r) => r.signature).length;
    notes.push(
      `embedded: ${bunApps} Bun standalone app(s) (${bunFiles} modules extracted to embedded/), Rust provenance for ${rustBins} binaries`,
      `${scanned} PE files (${records.length} unique by sha256, ${scanned - records.length} duplicate copies), ${skipped} non-PE files skipped`,
      `${signed} unique binaries carry an Authenticode signature (not verified), ${records.filter((r) => r.packedSections?.length).length} have high-entropy executable sections`,
    );
    return { status: 'ok', inputs: [appDir, asarDir], outputs: ['index.json', 'REPORT.md'], notes, limits: LIMITS };
  },
};
