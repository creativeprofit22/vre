// Stage 02: extract every Electron asar archive found by stage 01 (pure Node, no asar package).
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { checkIntegrity, openAsar, readPacked } from './lib/asar.mjs';

const LIMITS = [
  'Symlink entries are recorded in index.json but not created on disk.',
  'Native modules and executables are copied as-is; they are not disassembled.',
  'Integrity is checked against the per-file SHA-256 in the asar header; the header hash pinned in the Electron binary (EnableEmbeddedAsarIntegrityValidation) is not checked.',
];

async function findAsars(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.name.endsWith('.asar.unpacked')) await findAsars(p, out);
    else if (e.isFile() && e.name.endsWith('.asar')) out.push(p);
  }
  return out;
}

function inside(root, p) {
  const r = relative(root, p);
  return !!r && !isAbsolute(r) && !r.split(sep).includes('..');
}

/** Extract one archive into dest; returns a summary for index.json. */
export async function extractAsar(asarPath, dest) {
  const a = await openAsar(asarPath);
  const unpackedRoot = `${asarPath}.unpacked`;
  const res = { files: 0, bytes: 0, unpacked: 0, links: [], integrity: { ok: 0, failed: [], missing: 0 }, missingUnpacked: [] };
  try {
    for (const e of a.entries) {
      const target = join(dest, ...e.path.split('/'));
      if (!inside(dest, target)) throw new Error(`asar entry escapes output folder: ${e.path}`);
      if (e.type === 'dir') { await mkdir(target, { recursive: true }); continue; }
      if (e.type === 'link') { res.links.push({ path: e.path, link: e.link }); continue; }
      await mkdir(dirname(target), { recursive: true });
      if (e.unpacked) {
        const src = join(unpackedRoot, ...e.path.split('/'));
        try { await copyFile(src, target); res.unpacked++; } catch { res.missingUnpacked.push(e.path); continue; }
      } else {
        const buf = await readPacked(a.fh, a.dataOffset, e);
        const ok = checkIntegrity(buf, e.integrity);
        if (ok === true) res.integrity.ok++;
        else if (ok === false) res.integrity.failed.push(e.path);
        else res.integrity.missing++;
        await writeFile(target, buf);
      }
      res.files++;
      res.bytes += e.size;
    }
  } finally { await a.fh.close(); }
  return res;
}

export default {
  name: '02-asar',
  async run({ inDir, outDir, log }) {
    if (!inDir || !(await stat(inDir).catch(() => null))?.isDirectory()) {
      throw new Error(`02-asar needs stage 01 output at ${inDir}; run 01-installer first`);
    }
    const asars = (await findAsars(inDir)).sort();
    if (asars.length === 0) throw new Error(`no .asar archives found under ${inDir}`);
    const archives = [];
    const notes = [];
    const used = new Set();
    for (const src of asars) {
      let name = basename(src, '.asar');
      while (used.has(name)) name += '_';
      used.add(name);
      const dest = join(outDir, name);
      await rm(dest, { recursive: true, force: true });
      log(`02-asar: extracting ${relative(inDir, src)} -> ${name}/`);
      const r = await extractAsar(src, dest);
      archives.push({ name, source: relative(inDir, src).split(sep).join('/'), ...r });
      notes.push(`${name}: ${r.files} files, ${r.bytes} bytes, ${r.unpacked} from .asar.unpacked, integrity ok ${r.integrity.ok} / failed ${r.integrity.failed.length} / no-record ${r.integrity.missing}, ${r.links.length} symlinks, ${r.missingUnpacked.length} missing unpacked`);
      if (r.integrity.failed.length) notes.push(`${name}: INTEGRITY MISMATCH: ${r.integrity.failed.slice(0, 20).join(', ')}`);
    }
    await writeFile(join(outDir, 'index.json'), JSON.stringify({ archives }, null, 2) + '\n');
    const failed = archives.some((x) => x.integrity.failed.length || x.missingUnpacked.length);
    return { status: failed ? 'failed' : 'ok', inputs: asars, outputs: ['index.json'], notes, limits: LIMITS };
  },
};
