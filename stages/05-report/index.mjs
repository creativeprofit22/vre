// Stage 05: cross-stage summary of Voyager. Reads the output folders of stages 01-04 (siblings of
// this stage's outDir) and the manifest; never imports other stages.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildSummary, parseFlatYaml, runProbes } from './lib/summary.mjs';

const LIMITS = [
  'Summary only: every number comes from the outputs of stages 01-04, so their limits apply here too.',
  'Architecture statements are evidence probes (a literal or regex hit in the Electron main bundle, cited by file and byte offset); a matching string shows the code exists, not that it runs on every path.',
  'Probes that do not match are listed and their claims are left out rather than guessed.',
];

const readJson = async (/** @type {string} */ p) => JSON.parse(await readFile(p, 'utf8'));
const tryJson = async (/** @type {string} */ p) => { try { return await readJson(p); } catch { return null; } };
const tryText = async (/** @type {string} */ p) => { try { return await readFile(p, 'utf8'); } catch { return null; } };

export default {
  name: '05-report',
  async run({ outDir, manifest, log }) {
    const outRoot = dirname(outDir);
    const need = ['03-js/map.json', '04-native/index.json'];
    const missing = [];
    for (const n of need) if (!(await stat(join(outRoot, n)).catch(() => null))) missing.push(n);
    if (missing.length) throw new Error(`05-report needs ${missing.join(', ')} under ${outRoot}; run stages 03-js and 04-native first`);

    const map = await readJson(join(outRoot, '03-js', 'map.json'));
    const index = await tryJson(join(outRoot, '03-js', 'index.json'));
    const native = await readJson(join(outRoot, '04-native', 'index.json'));
    const appDir = join(outRoot, '02-asar', 'app');
    const appPkg = await tryJson(join(appDir, 'package.json'));
    const serverPkg = await tryJson(join(outRoot, '02-asar', 'server', 'package.json'));
    const feedText = await tryText(join(outRoot, '01-installer', 'app', 'resources', 'app-update.yml'));

    // Evidence probes run over the Electron main bundle(s) named by the app's package.json.
    const sources = [];
    if (appPkg?.main) {
      const mainRel = String(appPkg.main).replace(/\\/g, '/');
      const code = await tryText(join(appDir, ...mainRel.split('/')));
      if (code) sources.push({ file: `02-asar/app/${mainRel}`, code });
    }
    const probes = runProbes(sources);
    const notes = [];
    if (!sources.length) notes.push('warning: Electron main bundle not found; architecture probes skipped');

    const md = buildSummary({ manifest, updateFeed: feedText ? parseFlatYaml(feedText) : null, appPkg, serverPkg, js: { index, map }, native, probes });
    await writeFile(join(outDir, 'REPORT.md'), md + '\n');
    await writeFile(join(outDir, 'probes.json'), JSON.stringify(probes, null, 2) + '\n');
    const hit = probes.filter((p) => p.file).length;
    log(`05-report: ${hit}/${probes.length} architecture probes matched`);
    notes.push(`${hit}/${probes.length} architecture probes matched; summary in REPORT.md`);
    return { status: 'ok', inputs: [join(outRoot, '03-js'), join(outRoot, '04-native'), appDir], outputs: ['REPORT.md', 'probes.json'], notes, limits: LIMITS };
  },
};
