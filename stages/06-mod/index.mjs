// Stage 06: build a separate, modded copy of the installed Voyager (the installed app is only read).
// Order: resolve source -> assert fuses -> apply patches in memory (fail fast) -> copy -> repack asar(s) with loader -> verify.
// Reads the installed app (or the sibling 01-installer output as a fallback); never imports other stages.
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNode, openArchive, readFile as readAsarFile, repack } from './lib/asar.mjs';
import { assertModdable, readFuses } from './lib/fuses.mjs';
import { applyPatches, targetsOf, validatePatches } from './lib/patch.mjs';

/** Every file path in an asar header (folders walked, '/'-separated). */
export function listFiles(header, prefix = '') {
  const out = [];
  for (const [name, node] of Object.entries(header.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (node.files) out.push(...listFiles(node, p)); else out.push(p);
  }
  return out;
}

export const COPY_DIR = 'Voyager';
export const HOME_DIR = 'home';
export const LOADER = 'vre-loader.cjs';
export const HELPER_HOOK = 'vre-helper-hook.cjs';
export const APP_USER_MODEL_ID = 'design.moda.voyager.vre-mod';
// Never copied: the uninstaller would remove the REAL installation (it reads the registry, not its own folder).
const SKIP_TOP = new Set(['Uninstall Voyager.exe']);

const LIMITS = [
  'Fuses are only read and asserted (EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar must be OFF); nothing is flipped.',
  'Only JavaScript inside app.asar/server.asar is patched; native binaries (Voyager.exe, Rust helpers, .node addons) are copied unchanged. Helper launches are hookable (mods/helpers); helper internals are not.',
  'Isolation relies on Voyager\'s own env knobs (VOYAGER_HOME, VOYAGER_DISABLE_AUTO_UPDATE, VOYAGER_DESKTOP_APP_USER_MODEL_ID) set by the loader, plus the default patches; voyager:// registration is blocked in the copy.',
  'Remote services (Moda cloud models, billing, provider accounts) cannot be changed locally; the default patches and mods/main/no-auth.cjs switch every sign-in off instead.',
  'Renderer mods run in each top-level window\'s main world at dom-ready; webviews and background pages are skipped. Main-process and helper mods load once per launch (no hot reload).',
];

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function exists(p) { return !!(await stat(p).catch(() => null)); }

/** Pick the app folder to copy: VRE_VOYAGER_DIR, the per-user install, or stage 01's extraction. */
export async function resolveSource(outDir, env = process.env) {
  const candidates = [
    env.VRE_VOYAGER_DIR && { dir: env.VRE_VOYAGER_DIR, kind: 'VRE_VOYAGER_DIR' },
    env.LOCALAPPDATA && { dir: join(env.LOCALAPPDATA, 'Programs', 'voyager'), kind: 'installed' },
    { dir: join(dirname(outDir), '01-installer', 'app'), kind: '01-installer output' },
  ].filter(Boolean);
  for (const c of candidates) {
    if (await exists(join(c.dir, 'Voyager.exe')) && await exists(join(c.dir, 'resources', 'app.asar'))) return { ...c, dir: resolve(c.dir) };
    if (c.kind === 'VRE_VOYAGER_DIR') throw new Error(`VRE_VOYAGER_DIR=${c.dir} has no Voyager.exe + resources/app.asar`);
  }
  throw new Error(`no Voyager install found (tried ${candidates.map((c) => c.dir).join(', ')}); install Voyager, set VRE_VOYAGER_DIR, or run 01-installer`);
}

async function loadPatches(modsDir) {
  const file = join(modsDir, 'patches.json');
  if (!(await exists(file))) return [];
  try { return validatePatches(JSON.parse(await readFile(file, 'utf8'))); } catch (err) { throw new Error(`${file}: ${err.message}`); }
}

export default {
  name: '06-mod',
  async run({ outDir, log }) {
    const src = await resolveSource(outDir);
    const modsDir = process.env.VRE_MODS_DIR || join(repoRoot, 'mods');
    const copy = join(outDir, COPY_DIR);
    const home = join(outDir, HOME_DIR);
    log(`06-mod: source ${src.dir} (${src.kind}), mods ${modsDir}`);

    // 1. Fuses on the source exe: fail before touching anything.
    const srcFuses = await readFuses(join(src.dir, 'Voyager.exe'));
    assertModdable(srcFuses, `${src.kind} Voyager.exe`);

    // 2. Patches, applied in memory against the source archives.
    const patches = await loadPatches(modsDir);
    const archives = {};
    const texts = {};
    const listings = {};
    const list = (name) => (listings[name] ??= archives[name] ? listFiles(archives[name].header) : []);
    try {
      for (const name of new Set(['app', ...patches.map((p) => p.archive ?? 'app')])) {
        archives[name] = await openArchive(join(src.dir, 'resources', `${name}.asar`));
        texts[name] = {};
        for (const p of patches.filter((x) => (x.archive ?? 'app') === name)) {
          for (const file of targetsOf(p, list)) {
            if (file in texts[name]) continue;
            const buf = await readAsarFile(archives[name], file);
            texts[name][file] = buf && buf.toString('utf8');
          }
        }
      }
      const { files: patched, results } = applyPatches(patches, (a, f) => texts[a]?.[f] ?? null, list);
      for (const r of results) log(`06-mod: patch ${r.id}: ${r.count}/${r.expect} match(es) in ${r.archive}.asar/${r.file}${r.matched ? ` (${r.matched.join(', ')})` : ''}`);

      const pkg = JSON.parse((await readAsarFile(archives.app, 'package.json')).toString('utf8'));
      const originalMain = (pkg.main || 'index.js').replace(/^\.\//, '');
      if (originalMain === LOADER) throw new Error(`source app.asar already has ${LOADER} as main; point VRE_VOYAGER_DIR at an unmodified Voyager`);
      if (!findNode(archives.app.header, originalMain)) throw new Error(`package.json main ${originalMain} not found in app.asar`);

      // 3. Fresh copy (restore semantics): wipe the old copy, keep the copy's own data home.
      await rm(copy, { recursive: true, force: true });
      await mkdir(copy, { recursive: true });
      log(`06-mod: copying ${src.dir} -> ${copy}`);
      const skipAsars = new Set(Object.keys(archives).map((n) => resolve(src.dir, 'resources', `${n}.asar`)));
      await cp(src.dir, copy, {
        recursive: true,
        filter: (from) => !skipAsars.has(resolve(from)) && !(resolve(dirname(from)) === src.dir && SKIP_TOP.has(basename(from))),
      });

      // 4. Re-read fuses from the copy we will actually launch.
      const copyFuses = await readFuses(join(copy, 'Voyager.exe'));
      assertModdable(copyFuses, 'modded copy Voyager.exe');

      // 5. Repack archives: patched files, plus loader + rewritten package.json in app.asar.
      const stats = {};
      for (const [name, arch] of Object.entries(archives)) {
        const changes = new Map();
        for (const [key, text] of patched) if (key.startsWith(`${name}:`)) changes.set(key.slice(name.length + 1), Buffer.from(text, 'utf8'));
        if (name === 'app') {
          changes.set(LOADER, await readFile(new URL('./loader.cjs', import.meta.url)));
          changes.set('package.json', Buffer.from(JSON.stringify({ ...pkg, main: LOADER, vreOriginalMain: originalMain }, null, 2) + '\n'));
        }
        stats[name] = await repack(arch, join(copy, 'resources', `${name}.asar`), changes);
        log(`06-mod: repacked ${name}.asar (${changes.size} changed file(s), ${stats[name].files} packed files)`);
      }

      const config = { home, modsDir, originalMain, appUserModelId: APP_USER_MODEL_ID, version: pkg.version, source: src.dir, builtAt: new Date().toISOString() };
      await writeFile(join(copy, 'resources', 'vre-mod.json'), JSON.stringify(config, null, 2) + '\n');
      // Outside the asar on purpose: Voyager's backend server (a separate Node process) loads it via NODE_OPTIONS=--require.
      await writeFile(join(copy, 'resources', HELPER_HOOK), await readFile(new URL('./helper-hook.cjs', import.meta.url)));
      await mkdir(home, { recursive: true });

      // 6. Verify the repacked archive reads back with the loader wired in.
      const check = await openArchive(join(copy, 'resources', 'app.asar'));
      try {
        const main = JSON.parse((await readAsarFile(check, 'package.json')).toString('utf8')).main;
        const loader = await readAsarFile(check, LOADER);
        if (main !== LOADER || !loader) throw new Error('repacked app.asar does not start with the vre loader');
        for (const [key, text] of patched) {
          if (!key.startsWith('app:')) continue;
          const got = await readAsarFile(check, key.slice(4));
          if (!got || got.toString('utf8') !== text) throw new Error(`repacked app.asar has wrong content for ${key.slice(4)}`);
        }
      } finally { await check.fh.close(); }
      for (const name of Object.keys(archives).filter((n) => n !== 'app')) {
        const other = await openArchive(join(copy, 'resources', `${name}.asar`));
        try {
          for (const [key, text] of patched) {
            if (!key.startsWith(`${name}:`)) continue;
            const got = await readAsarFile(other, key.slice(name.length + 1));
            if (!got || got.toString('utf8') !== text) throw new Error(`repacked ${name}.asar has wrong content for ${key.slice(name.length + 1)}`);
          }
        } finally { await other.fh.close(); }
      }

      const build = { source: src, version: pkg.version, originalMain, fuses: { source: srcFuses.fuses, copy: copyFuses.fuses }, patches: results, archives: stats, config };
      await writeFile(join(outDir, 'build.json'), JSON.stringify(build, null, 2) + '\n');
      const rel = (p) => relative(outDir, p).split(sep).join('/');
      return {
        status: 'ok',
        inputs: [src.dir, modsDir],
        outputs: ['build.json', rel(join(copy, 'resources', 'app.asar')), rel(join(copy, 'resources', 'vre-mod.json')), rel(join(copy, 'resources', HELPER_HOOK))],
        notes: [
          `source: ${src.dir} (${src.kind}), Voyager ${pkg.version}`,
          `fuses: ${Object.entries(copyFuses.fuses).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          `patches: ${results.length} applied (${results.map((r) => `${r.id} ${r.count}/${r.expect}`).join(', ') || 'none'})`,
          `copy: ${copy}; launch with: node cli/vre.mjs mod launch`,
          `data home (kept across rebuilds): ${home}`,
        ],
        limits: LIMITS,
      };
    } finally {
      for (const a of Object.values(archives)) await a.fh.close().catch(() => {});
    }
  },
};
