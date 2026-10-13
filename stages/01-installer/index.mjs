// Stage 01: unpack the NSIS installer (electron-builder) with 7-Zip, then the nested app-<arch>.7z.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const LIMITS = [
  'Requires an external 7-Zip binary (7z/7za/7zz on PATH, or VRE_7Z); version recorded in notes.',
  'Only NSIS installers are supported (electron-builder layout with $PLUGINSDIR/app-<arch>.7z).',
  'NSIS install script logic (registry writes, shortcuts, custom pages) is not decompiled; only the payload is extracted.',
];

const SEVEN_ZIP_CANDIDATES = ['7z', '7za', '7zz'];

/** Find a working 7-Zip binary. Returns { cmd, version } or null. */
export function find7z(env = process.env) {
  const list = env.VRE_7Z ? [env.VRE_7Z] : SEVEN_ZIP_CANDIDATES;
  for (const cmd of list) {
    const r = spawnSync(cmd, [], { encoding: 'utf8', windowsHide: true });
    if (r.error) continue;
    const line = `${r.stdout ?? ''}`.split(/\r?\n/).find((l) => /7-Zip/i.test(l));
    if (line) return { cmd, version: line.trim() };
  }
  return null;
}

/** Offset of the NSIS first-header signature ("NullsoftInst") in buf, or -1. */
export function findNsisSignature(buf) {
  return buf.indexOf(Buffer.from('NullsoftInst', 'latin1'));
}

async function readHead(path, bytes) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

function run7z(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`7-Zip ${args[0]} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

function sha256(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', rej).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex')));
  });
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const rel = (from, p) => relative(from, p).split(sep).join('/');

export default {
  name: '01-installer',
  async run({ outDir, input, log }) {
    if (!input) throw new Error('01-installer needs --input <path to VY.exe>');
    const info = await stat(input).catch(() => null);
    if (!info?.isFile()) throw new Error(`input not found: ${input}`);
    const head = await readHead(input, 8 << 20);
    if (head.readUInt16LE(0) !== 0x5a4d) throw new Error(`input is not a Windows PE executable: ${input}`);
    const sig = findNsisSignature(head);
    if (sig < 0) throw new Error('input is not an NSIS installer (no "NullsoftInst" signature in the first 8 MB)');
    const tool = find7z();
    if (!tool) throw new Error('7-Zip not found: install 7-Zip (7z/7za/7zz on PATH) or set VRE_7Z');

    const nsisDir = join(outDir, 'nsis');
    const appDir = join(outDir, 'app');
    await rm(nsisDir, { recursive: true, force: true });
    await rm(appDir, { recursive: true, force: true });

    const listing = run7z(tool.cmd, ['l', input]);
    const prop = (k) => listing.match(new RegExp(`^${k} = (.*)$`, 'm'))?.[1]?.trim();
    log(`01-installer: extracting ${input} with ${tool.version}`);
    run7z(tool.cmd, ['x', input, `-o${nsisDir}`, '-y']);

    const plugins = join(nsisDir, '$PLUGINSDIR');
    const payloads = (await readdir(plugins).catch(() => [])).filter((f) => /^app-.*\.7z$/i.test(f));
    if (payloads.length === 0) throw new Error('no $PLUGINSDIR/app-*.7z payload found: not an electron-builder NSIS installer?');
    const payload = payloads.find((f) => /app-64/i.test(f)) ?? payloads[0];
    log(`01-installer: extracting ${payload}`);
    run7z(tool.cmd, ['x', join(plugins, payload), `-o${appDir}`, '-y']);

    // File inventory with hashes (the manifest only lists key artifacts).
    const files = [];
    for (const p of [...await walk(nsisDir), ...await walk(appDir)]) {
      const s = await stat(p);
      files.push({ path: rel(outDir, p), size: s.size, sha256: await sha256(p) });
    }
    await writeFile(join(outDir, 'files.json'), JSON.stringify({ input, files }, null, 2) + '\n');

    const key = files
      .map((f) => f.path)
      .filter((p) => /^app\/[^/]+\.exe$/i.test(p) || /^app\/resources\/[^/]+\.(asar|yml|json)$/i.test(p));
    const notes = [
      `installer: ${prop('Type') ?? 'Nsis'} ${prop('SubType') ?? ''}`.trim() + `, method ${prop('Method') ?? '?'}, solid ${prop('Solid') ?? '?'}, stub ${prop('Embedded Stub Size') ?? '?'} bytes, NSIS signature at ${sig}`,
      `payload: $PLUGINSDIR/${payload} (${payloads.length} candidate(s): ${payloads.join(', ')})`,
      `tool: ${tool.version}`,
      `extracted ${files.length} files (${files.reduce((a, f) => a + f.size, 0)} bytes); full inventory in files.json`,
    ];
    const upd = await readFile(join(appDir, 'resources', 'app-update.yml'), 'utf8').catch(() => null);
    if (upd) notes.push(`app-update.yml: ${upd.trim().replace(/\r?\n/g, '; ')}`);
    return { status: 'ok', inputs: [input], outputs: ['files.json', ...key], notes, limits: LIMITS };
  },
};
