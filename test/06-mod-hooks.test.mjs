// 06-mod mod surfaces: glob patches, the helper (child_process) hook, node mods, and the no-auth mods.
// No Voyager, VY.exe or 7-Zip needed: the hook is exercised with plain Node child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches, globToRegExp, targetsOf } from '../stages/06-mod/lib/patch.mjs';
import { listFiles } from '../stages/06-mod/index.mjs';

const require = createRequire(import.meta.url);
const HOOK = fileURLToPath(new URL('../stages/06-mod/helper-hook.cjs', import.meta.url));
const MODS = fileURLToPath(new URL('../mods/', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'vre-hooks-'));

test('glob patches: hashed file names match, expect is the total across files, misses fail loudly', () => {
  assert.ok(globToRegExp('dist/assets/main-*.js').test('dist/assets/main-AbC_12.js'));
  assert.ok(!globToRegExp('dist/assets/main-*.js').test('dist/assets/sub/main-x.js'));
  assert.ok(globToRegExp('dist/**/x.js').test('dist/a/b/x.js'));
  const files = { 'd/main-a1.js': 'function q(e){return!e.enabled||1}', 'd/main-b2.js': 'loader only', 'd/other.js': 'x' };
  const list = () => Object.keys(files);
  const read = (_a, f) => files[f] ?? null;
  const patch = { id: 'g', archive: 'server', file: 'd/main-*.js', regex: true, find: 'function ([\\w$]+)\\(e\\)\\{return!e\\.enabled', replace: 'function $1(e){return 0;return!e.enabled', expect: 1 };
  assert.deepEqual(targetsOf(patch, list), ['d/main-a1.js', 'd/main-b2.js']);
  const { files: out, results } = applyPatches([patch], read, list);
  assert.equal(out.get('server:d/main-a1.js'), 'function q(e){return 0;return!e.enabled||1}');
  assert.ok(!out.has('server:d/main-b2.js'), 'files with no match are not rewritten');
  assert.deepEqual(results[0].matched, ['d/main-a1.js']);
  assert.throws(() => applyPatches([{ ...patch, expect: 2 }], read, list), /g: expected 2 match\(es\).*found 1/s);
  assert.throws(() => applyPatches([{ ...patch, file: 'nope/*.js' }], read, list), /no file matches/);
  assert.deepEqual(listFiles({ files: { a: { files: { 'b.js': {} } }, 'c.js': {} } }), ['a/b.js', 'c.js']);
});

test('helper hook: mods see every launch and can rewrite file, args, env and stdio', () => {
  const cp = require('node:child_process');
  const { install } = require(HOOK);
  const seen = [];
  const state = install({ log: () => {}, installDir: tmpdir(), proc: 'test' });
  state.handlers.push((call) => {
    seen.push(`${call.api}:${call.file}`);
    if (call.file === 'fake-helper') { // point the call at a replacement binary with new args and env
      call.file = process.execPath;
      call.args = ['-e', 'process.stdout.write(process.env.VRE_T + ":" + process.argv.slice(1).join(","))', ...call.args];
      call.options.env = { ...process.env, VRE_T: 'rewritten' };
      call.options.encoding = 'utf8';
    }
  });
  const r = cp.spawnSync('fake-helper', ['a', 'b'], {});
  assert.equal(r.stdout, 'rewritten:a,b');
  assert.equal(cp.execFileSync('fake-helper', ['c']), 'rewritten:c');
  assert.equal(require('node:child_process').spawnSync, cp.spawnSync);
  assert.deepEqual(seen, ['spawnSync:fake-helper', 'execFileSync:fake-helper']);
  assert.equal(install({}), state, 'installs once per process');
});

test('helper hook follows Voyager Node children (NODE_OPTIONS) and loads helper + node mods there', async () => {
  const root = await tmp();
  try {
    const mods = join(root, 'my mods'); // a space in the path, like "SPARTAN PC"
    await mkdir(join(mods, 'helpers'), { recursive: true });
    await mkdir(join(mods, 'node'), { recursive: true });
    await writeFile(join(mods, 'helpers', 'tag.cjs'), "module.exports = (call, { log }) => log(`child-launch ${call.api} ${call.proc.split(':')[0]}`);\n");
    await writeFile(join(mods, 'node', 'hello.cjs'), "module.exports = ({ log, proc }) => log(`node-mod-ran ${proc.split(':')[0]}`);\n");
    const logFile = join(root, 'vre-mods.log');
    // Parent: the hook installed as in the main process; child: Voyager.exe-as-node (here: node, ELECTRON_RUN_AS_NODE=1);
    // grandchild: an unrelated process, which must not inherit the preload.
    const grandchild = join(root, 'grandchild.cjs');
    await writeFile(grandchild, "process.stdout.write(String(process.env.NODE_OPTIONS || 'none'));\n");
    const child = join(root, 'child.cjs');
    await writeFile(child, `const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(grandchild)}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, encoding: 'utf8' });\nprocess.stdout.write(r.stdout + r.stderr);\n`);
    const parent = join(root, 'parent.cjs');
    await writeFile(parent, `const { install } = require(${JSON.stringify(HOOK)});
install({ log: () => {}, modsDir: ${JSON.stringify(mods)}, installDir: ${JSON.stringify(root)}, proc: 'main', hookFile: ${JSON.stringify(HOOK)}, logFile: ${JSON.stringify(logFile)} });
const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(child)}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
process.stdout.write(r.stdout + r.stderr);\n`);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [parent], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'none', 'the preload is stripped before reaching unrelated grandchildren');
    const log = await readFile(logFile, 'utf8');
    assert.match(log, /helper hook active in node child/);
    assert.match(log, /node-mod-ran node-child/);
    assert.match(log, /child-launch spawnSync node-child/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('no-auth: sign-in URLs are recognised, ordinary links are not', () => {
  const { isSignInUrl } = require(join(MODS, 'main', 'no-auth.cjs'));
  for (const u of ['https://auth.openai.com/api/accounts/authorize?client_id=x', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1',
    'https://clerk.moda.app/v1/client', 'https://github.com/login/oauth/authorize?client_id=a', 'https://example.com/sign-in', 'https://x.dev/device'])
    assert.ok(isSignInUrl(u), u);
  for (const u of ['https://github.com/usevoyager/voyager-releases', 'https://docs.example.com/guide', 'not a url', 'file:///C:/x.txt'])
    assert.ok(!isSignInUrl(u), u);
});

test('no-auth-browser helper mod swaps a browser launch of a sign-in page for a no-op', () => {
  const mod = require(join(MODS, 'helpers', 'no-auth-browser.cjs'));
  const logs = [];
  const call = { api: 'spawn', file: 'cmd.exe', args: ['/c', 'start', '', 'https://github.com/login/oauth/authorize?client_id=a'], options: {}, proc: 'main' };
  mod(call, { log: (m) => logs.push(m) });
  assert.deepEqual(call.args, ['/d', '/c', 'exit 0']);
  assert.match(logs[0], /blocked sign-in launch/);
  const other = { api: 'spawn', file: 'ffmpeg.exe', args: ['-i', 'https://cdn.example.com/a.mp4'], options: {}, proc: 'main' };
  mod(other, { log: () => {} });
  assert.equal(other.file, 'ffmpeg.exe');
});

test('no-auth-account node mod makes the saved account read as signed out without touching the file', async () => {
  const root = await tmp();
  try {
    const home = join(root, 'home');
    await mkdir(join(home, 'media'), { recursive: true });
    const identity = JSON.stringify({ email: 'someone@example.com' });
    await writeFile(join(home, 'media', 'moda.json'), identity);
    await writeFile(join(home, 'media', 'other.json'), '{"keep":1}');
    const code = `
      require(${JSON.stringify(join(MODS, 'node', 'no-auth-account.cjs'))})({ log: () => {}, home: ${JSON.stringify(home)}, proc: 'test' });
      const fs = require('node:fs'); const p = require('node:path');
      const f = p.join(${JSON.stringify(home)}, 'media', 'moda.json');
      (async () => {
        const esm = await import('node:fs/promises');
        const out = [fs.readFileSync(f, 'utf8'), String(fs.readFileSync(f)), await fs.promises.readFile(f, 'utf8'), await esm.readFile(f, 'utf8'),
          await new Promise((r) => fs.readFile(f, 'utf8', (e, t) => r(t))), fs.readFileSync(p.join(${JSON.stringify(home)}, 'media', 'other.json'), 'utf8')];
        process.stdout.write(JSON.stringify(out));
      })();`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['null', 'null', 'null', 'null', 'null', '{"keep":1}']);
    assert.equal(await readFile(join(home, 'media', 'moda.json'), 'utf8'), identity, 'file on disk unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shipped patches.json is valid and every no-auth patch is a server.asar patch with an expected count', async () => {
  const { validatePatches } = await import('../stages/06-mod/lib/patch.mjs');
  const patches = validatePatches(JSON.parse(await readFile(join(MODS, 'patches.json'), 'utf8')));
  const noAuth = patches.filter((p) => p.id.startsWith('no-auth-'));
  assert.ok(noAuth.length >= 3);
  for (const p of noAuth) { assert.equal(p.archive, 'server'); assert.equal(p.expect, 1); }
});
