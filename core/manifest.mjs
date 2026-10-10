import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANIFEST_NAME = 'manifest.json';

export function manifestPath(outDir) {
  return join(outDir, MANIFEST_NAME);
}

export async function readManifest(outDir) {
  try {
    return JSON.parse(await readFile(manifestPath(outDir), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, entries: [] };
    throw err;
  }
}

async function writeManifest(outDir, manifest) {
  await mkdir(outDir, { recursive: true });
  const target = manifestPath(outDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
  await rename(tmp, target);
}

/** Append (or replace, by stage name) an entry. */
export async function addEntry(outDir, entry) {
  for (const k of ['stage', 'status']) {
    if (typeof entry[k] !== 'string' || !entry[k]) throw new Error(`manifest entry needs "${k}"`);
  }
  const manifest = await readManifest(outDir);
  const full = {
    inputs: [],
    outputs: [],
    sha256: {},
    tool: null,
    limits: [],
    time: new Date().toISOString(),
    ...entry,
  };
  manifest.entries = manifest.entries.filter((e) => e.stage !== full.stage);
  manifest.entries.push(full);
  await writeManifest(outDir, manifest);
  return full;
}

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}
