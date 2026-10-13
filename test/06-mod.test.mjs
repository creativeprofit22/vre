import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertModdable, FUSE_NAMES, parseFuses, readFuses, SENTINEL } from '../stages/06-mod/lib/fuses.mjs';
import { applyOne, applyPatches, validatePatches } from '../stages/06-mod/lib/patch.mjs';
import { encodeHeader, integrityOf, openArchive, readFile as readAsar, repack } from '../stages/06-mod/lib/asar.mjs';
import { checkIntegrity, openAsar } from '../stages/02-asar/lib/asar.mjs';
import stage from '../stages/06-mod/index.mjs';
import { launchMod } from '../cli/vre.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'vre06-'));

/** Fake Electron exe: junk, sentinel, version 1, wire of '0'/'1' per fuse. */
function fakeExe(states, { version = 1, pad = 1000 } = {}) {
  const wire = Buffer.from(FUSE_NAMES.map((n) => (states[n] ?? '0')).join(''), 'latin1');
  return Buffer.concat([Buffer.alloc(pad, 0x90), SENTINEL, Buffer.from([version, wire.length]), wire, Buffer.alloc(64)]);
}

/** Build a small asar (pure helper, independent from repack) from { path: string|Buffer }. */
function buildAsar(files) {
  const header = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [p, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const segs = p.split('/');
    let node = header;
    for (const s of segs.slice(0, -1)) node = node.files[s] ??= { files: {} };
    node.files[segs.at(-1)] = { size: buf.length, offset: String(offset), integrity: integrityOf(buf) };
    blobs.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([encodeHeader(header), ...blobs]);
}

// ---- fuses ----

test('fuse reader parses the wire and the assert passes when integrity + asar-only are off', async () => {
  const buf = fakeExe({ RunAsNode: '1', EnableCookieEncryption: '0' });
  const w = parseFuses(buf);
  assert.equal(w.version, 1);
  assert.equal(w.length, FUSE_NAMES.length);
  assert.equal(w.fuses.RunAsNode, 'on');
  assert.equal(w.fuses.EnableEmbeddedAsarIntegrityValidation, 'off');
  assert.equal(assertModdable(w), true);
  const dir = await tmp();
  try {
    // Sentinel placed across the reader's 4 MiB chunk boundary still found.
    const exe = join(dir, 'Voyager.exe');
    await writeFile(exe, fakeExe({}, { pad: (4 << 20) - 10 }));
    assert.equal((await readFuses(exe)).fuses.OnlyLoadAppFromAsar, 'off');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fuse assert fails loudly when integrity validation or OnlyLoadAppFromAsar is on', () => {
  assert.throws(() => assertModdable(parseFuses(fakeExe({ EnableEmbeddedAsarIntegrityValidation: '1' }))), /EnableEmbeddedAsarIntegrityValidation=on must be OFF/);
  assert.throws(() => assertModdable(parseFuses(fakeExe({ OnlyLoadAppFromAsar: '1' }))), /OnlyLoadAppFromAsar=on.*does not flip fuses/s);
  assert.throws(() => assertModdable(parseFuses(fakeExe({}, { version: 2 }))), /unsupported fuse wire version 2/);
  assert.equal(assertModdable(parseFuses(fakeExe({ OnlyLoadAppFromAsar: 'r' }))), true); // removed fuse = not enforced
  assert.throws(() => parseFuses(Buffer.alloc(100)), /no Electron fuse sentinel/);
});

// ---- patches ----

test('patches apply when the match count equals expect (string and regex)', () => {
  assert.deepEqual(applyOne('a.b a.b', { find: 'a.b', replace: 'X' }), { text: 'X X', count: 2 }); // literal, not regex
  assert.deepEqual(applyOne('v1 v22', { find: 'v(\\d+)', regex: true, replace: 'w$1' }), { text: 'w1 w22', count: 2 });
  const src = { 'app:main.js': 'function f(args) {\n return 1;\n}', 'server:s.js': 'x=1;x=1;' };
  const { files, results } = applyPatches([
    { id: 'p1', file: 'main.js', find: 'function f(args) {', replace: 'function f(args) {return 0;', expect: 1 },
    { id: 'p2', file: 'main.js', find: 'return 1', replace: 'return 2', expect: 1 }, // stacks on p1's output
    { id: 'p3', archive: 'server', file: 's.js', find: 'x=1', replace: 'x=2', expect: 2 },
  ], (a, f) => src[`${a}:${f}`] ?? null);
  assert.equal(files.get('app:main.js'), 'function f(args) {return 0;\n return 2;\n}');
  assert.equal(files.get('server:s.js'), 'x=2;x=2;');
  assert.deepEqual(results.map((r) => r.count), [1, 1, 2]);
});

test('patch count mismatch fails the build and lists every broken patch', () => {
  const read = (_a, f) => (f === 'main.js' ? 'foo foo' : null);
  assert.throws(() => applyPatches([
    { id: 'too-few', file: 'main.js', find: 'bar', replace: 'x', expect: 1 },
    { id: 'too-many', file: 'main.js', find: 'foo', replace: 'x', expect: 1 },
    { id: 'ok', file: 'main.js', find: 'foo', replace: 'x', expect: 2 },
    { id: 'gone', file: 'nope.js', find: 'foo', replace: 'x', expect: 1 },
  ], read), (err) => {
    assert.match(err.message, /patch check failed \(3\)/);
    assert.match(err.message, /too-few: expected 1 match\(es\) in app\.asar\/main\.js, found 0/);
    assert.match(err.message, /too-many: expected 1 match\(es\) in app\.asar\/main\.js, found 2/);
    assert.match(err.message, /gone: file not found/);
    assert.doesNotMatch(err.message, /\bok:/);
    return true;
  });
});

test('patch list validation rejects malformed patches', () => {
  const base = { id: 'a', file: 'm.js', find: 'x', replace: 'y', expect: 1 };
  assert.equal(validatePatches([base]).length, 1);
  assert.throws(() => validatePatches({}), /JSON array/);
  assert.throws(() => validatePatches([{ ...base, expect: undefined }]), /integer "expect"/);
  assert.throws(() => validatePatches([{ ...base, expect: -1 }]), /integer "expect"/);
  assert.throws(() => validatePatches([base, base]), /duplicate id/);
  assert.throws(() => validatePatches([{ ...base, file: '../x.js' }]), /relative path/);
  assert.throws(() => validatePatches([{ ...base, archive: 'other' }]), /"archive"/);
  assert.throws(() => validatePatches([{ ...base, regex: true, find: '(' }]), SyntaxError);
});

// ---- asar repack ----

test('repack replaces and adds files, keeps others byte-identical, and reads back via the 02-asar reader', async () => {
  const dir = await tmp();
  try {
    const big = Buffer.alloc((4 << 20) + 123, 7); // spans two integrity blocks
    await writeFile(join(dir, 'in.asar'), buildAsar({ 'package.json': '{"main":"a/main.js"}', 'a/main.js': 'old', 'a/big.bin': big }));
    const arch = await openArchive(join(dir, 'in.asar'));
    try {
      await repack(arch, join(dir, 'out.asar'), new Map([['a/main.js', Buffer.from('new code')], ['loader.cjs', Buffer.from('L')]]));
    } finally { await arch.fh.close(); }
    const out = await openAsar(join(dir, 'out.asar'));
    try {
      const read = async (p) => {
        const e = out.entries.find((x) => x.path === p);
        const buf = Buffer.alloc(e.size);
        await out.fh.read(buf, 0, e.size, out.dataOffset + Number(e.offset));
        assert.equal(checkIntegrity(buf, e.integrity), true, `integrity of ${p}`);
        return buf;
      };
      assert.equal((await read('a/main.js')).toString(), 'new code');
      assert.equal((await read('loader.cjs')).toString(), 'L');
      assert.ok((await read('a/big.bin')).equals(big));
      assert.equal((await read('package.json')).toString(), '{"main":"a/main.js"}');
    } finally { await out.fh.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- stage ----

async function fakeInstall(root, { fuses = {}, main = 'a/main.js' } = {}) {
  const app = join(root, 'install');
  await mkdir(join(app, 'resources'), { recursive: true });
  await writeFile(join(app, 'Voyager.exe'), fakeExe(fuses));
  await writeFile(join(app, 'Uninstall Voyager.exe'), 'uninstaller');
  await writeFile(join(app, 'resources', 'app.asar'), buildAsar({ 'package.json': JSON.stringify({ name: 'voyager', version: '9.9.9', main }), 'a/main.js': 'function gate(args) {\n return null;\n}' }));
  return app;
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('06-mod builds an isolated copy with the loader as main and patches applied', async () => {
  const root = await tmp();
  try {
    const src = await fakeInstall(root);
    const mods = join(root, 'mods');
    await mkdir(mods);
    await writeFile(join(mods, 'patches.json'), JSON.stringify([{ id: 'gate-off', file: 'a/main.js', find: 'function gate(args) {', replace: 'function gate(args) {\n return "off";', expect: 1 }]));
    const outDir = join(root, 'out', '06-mod');
    const res = await withEnv({ VRE_VOYAGER_DIR: src, VRE_MODS_DIR: mods }, () => stage.run({ outDir, log: () => {} }));
    assert.equal(res.status, 'ok');
    const copy = join(outDir, 'Voyager');
    await assert.rejects(readFile(join(copy, 'Uninstall Voyager.exe')), /ENOENT/);
    const arch = await openArchive(join(copy, 'resources', 'app.asar'));
    try {
      const pkg = JSON.parse((await readAsar(arch, 'package.json')).toString());
      assert.equal(pkg.main, 'vre-loader.cjs');
      assert.equal(pkg.vreOriginalMain, 'a/main.js');
      assert.match((await readAsar(arch, 'vre-loader.cjs')).toString(), /VOYAGER_DISABLE_AUTO_UPDATE/);
      assert.match((await readAsar(arch, 'a/main.js')).toString(), /return "off"/);
    } finally { await arch.fh.close(); }
    const cfg = JSON.parse(await readFile(join(copy, 'resources', 'vre-mod.json'), 'utf8'));
    assert.equal(cfg.home, join(outDir, 'home'));
    assert.equal(cfg.originalMain, 'a/main.js');
    assert.notEqual(cfg.appUserModelId, 'design.moda.voyager');
    // Source untouched.
    const srcArch = await openArchive(join(src, 'resources', 'app.asar'));
    try { assert.equal(JSON.parse((await readAsar(srcArch, 'package.json')).toString()).main, 'a/main.js'); } finally { await srcArch.fh.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('06-mod fails before copying when a fuse is on or a patch count is off', async () => {
  const root = await tmp();
  try {
    const outDir = join(root, 'out', '06-mod');
    const mods = join(root, 'mods');
    await mkdir(mods);
    const hardened = await fakeInstall(join(root, 'h'), { fuses: { EnableEmbeddedAsarIntegrityValidation: '1' } });
    await assert.rejects(withEnv({ VRE_VOYAGER_DIR: hardened, VRE_MODS_DIR: mods }, () => stage.run({ outDir, log: () => {} })), /EnableEmbeddedAsarIntegrityValidation=on must be OFF/);
    const src = await fakeInstall(join(root, 's'));
    await writeFile(join(mods, 'patches.json'), JSON.stringify([{ id: 'stale', file: 'a/main.js', find: 'not in this version', replace: 'x', expect: 1 }]));
    await assert.rejects(withEnv({ VRE_VOYAGER_DIR: src, VRE_MODS_DIR: mods }, () => stage.run({ outDir, log: () => {} })), /stale: expected 1 match\(es\).*found 0/s);
    await assert.rejects(readFile(join(outDir, 'Voyager', 'Voyager.exe')), /ENOENT/); // nothing copied
    await assert.rejects(withEnv({ VRE_VOYAGER_DIR: join(root, 'missing') }, () => stage.run({ outDir, log: () => {} })), /VRE_VOYAGER_DIR/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mod launch refuses without a built copy and spawns the copy detached otherwise', async () => {
  const root = await tmp();
  try {
    await assert.rejects(launchMod({ out: root, log: () => {} }), /mod rebuild/);
    const exe = join(root, '06-mod', 'Voyager', 'Voyager.exe');
    await mkdir(join(root, '06-mod', 'Voyager'), { recursive: true });
    await writeFile(exe, '');
    const calls = [];
    await launchMod({ out: root, log: () => {}, spawnFn: (cmd, args, opts) => { calls.push([cmd, opts.detached]); return { pid: 1, unref() {} }; } });
    assert.deepEqual(calls, [[exe, true]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
