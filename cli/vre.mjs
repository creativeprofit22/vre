#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { addEntry, hashFile, readManifest } from '../core/manifest.mjs';
import { assertStage } from '../core/stage.mjs';
import { STAGES, loadStage } from './registry.mjs';

const USAGE = `usage:
  vre run [--input VY.exe] [--out out]
  vre stage <${STAGES.join('|')}> [--input VY.exe] [--out out]`;

export async function runStage(name, { input = null, out = 'out', log = console.log, load = loadStage } = {}) {
  const stage = assertStage(await load(name), name);
  const outRoot = resolve(out);
  const idx = STAGES.indexOf(name);
  const inDir = idx > 0 ? join(outRoot, STAGES[idx - 1]) : null;
  const outDir = join(outRoot, name);
  await mkdir(outDir, { recursive: true });
  const manifest = await readManifest(outRoot);
  let res;
  try {
    res = await stage.run({ inDir, outDir, input: input && resolve(input), manifest, log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addEntry(outRoot, { stage: name, status: 'failed', inputs: [], outputs: [], notes: [message] });
    throw err;
  }
  const sha256 = {};
  for (const f of res.outputs ?? []) sha256[f] = await hashFile(join(outDir, f));
  return addEntry(outRoot, {
    stage: name,
    status: res.status,
    inputs: res.inputs ?? [],
    outputs: res.outputs ?? [],
    sha256,
    tool: `vre/${name}`,
    limits: res.limits ?? [],
    notes: res.notes ?? [],
  });
}

export async function runAll(opts) {
  const entries = [];
  for (const name of STAGES) entries.push(await runStage(name, opts));
  return entries;
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { input: { type: 'string' }, out: { type: 'string', default: 'out' } },
  });
  const [cmd, name] = positionals;
  const opts = { input: values.input ?? process.env.VRE_INPUT ?? null, out: values.out };
  if (cmd === 'run' && !name) await runAll(opts);
  else if (cmd === 'stage' && name) await runStage(name, opts);
  else {
    console.error(USAGE);
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err.message); process.exitCode = 1; },
  );
}
