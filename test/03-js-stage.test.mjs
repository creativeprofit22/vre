// @ts-check
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import stage from '../stages/03-js/index.mjs';
import { scanFile, packageFromPath, finalizeMap, createMapAcc, addScan } from '../stages/03-js/lib/map.mjs';
import { classify, extractImports, normalizeRegionPath, splitRegions, stripComments } from '../stages/03-js/lib/regions.mjs';

const quiet = () => {};

test('splitRegions splits blocks and keeps unregioned code', () => {
  const src = 'var a=1;\n//#region src/a.ts\nconst A=1;\n//#endregion\nmid();\n//#region \\0rolldown/runtime.js\nR();\n//#endregion\n//# debugId=abc\n';
  const { regions, unregioned } = splitRegions(src);
  assert.deepEqual(regions, [{ path: 'src/a.ts', code: 'const A=1;\n' }, { path: '\\0rolldown/runtime.js', code: 'R();\n' }]);
  assert.equal(unregioned, 'var a=1;\nmid();\n//# debugId=abc\n');
});

test('normalizeRegionPath is safe', () => {
  assert.equal(normalizeRegionPath('../../packages/x/src/a.ts'), 'packages/x/src/a.ts');
  assert.equal(normalizeRegionPath('\0rolldown/runtime.js'), '_virtual/rolldown/runtime.js');
  assert.equal(normalizeRegionPath('\\0rolldown/runtime.js'), '_virtual/rolldown/runtime.js');
  assert.equal(normalizeRegionPath('src/../../../etc/passwd'), null);
  assert.equal(normalizeRegionPath('a/../../b'), null);
  assert.equal(normalizeRegionPath('/abs/x.ts'), 'abs/x.ts');
  assert.equal(normalizeRegionPath('C:\\win\\x.ts'), 'win/x.ts');
  assert.equal(normalizeRegionPath('src/a:b?.ts'), 'src/a_b_.ts');
  assert.equal(normalizeRegionPath('src/con.ts'), 'src/_con.ts');
  assert.equal(normalizeRegionPath('../..'), null);
});

test('extractImports finds static, re-export, require and dynamic imports, not comments', () => {
  const code = stripComments(`import a from "a";\nimport {b} from 'b';\nimport "side";\nexport * from "c";\nexport { d } from 'd';\nconst e = require("e");\nawait import('f');\n// require("nope")\n/* import x from "nope2" */\nconst s = "// not a comment";`);
  assert.deepEqual(extractImports(code), ['a', 'b', 'c', 'd', 'e', 'f', 'side']);
  assert.match(code, /not a comment/);
});

test('IPC channel resolution, flags, urls, env', () => {
  const code = `const CH = "app:open";\nipcMain.handle(CH, f);\nipcMain.on('direct', g);\nipcRenderer.invoke(X.y, 1);\nwebContents.send("evt");\ncontextBridge.exposeInMainWorld("api", {});\nnew BrowserWindow({ webPreferences: { contextIsolation: true, nodeIntegration: !1, preload: p } });\nfetch("https://api.example.com/v1");\nprocess.env.FOO; process.env["BAR"];\n//# debugId=1234abcd-1111\n`;
  const s = scanFile(stripComments(code), code);
  const ch = s.calls.filter((c) => c.api === 'ipcMain').map((c) => c.channel);
  assert.deepEqual(ch, ['app:open', 'direct']);
  assert.equal(s.calls.find((c) => c.api === 'ipcRenderer')?.channel, null);
  assert.deepEqual(s.flags.map((f) => `${f.flag}=${f.value}`), ['contextIsolation=true', 'nodeIntegration=false', 'preload=p']);
  assert.deepEqual(s.urls, ['https://api.example.com/v1']);
  assert.deepEqual(s.env, ['BAR', 'FOO']);
  assert.deepEqual(s.debugIds, ['1234abcd-1111']);
  const acc = createMapAcc(); addScan(acc, 'app/x.cjs', s);
  const m = finalizeMap(acc);
  assert.deepEqual(m.electron.exposeInMainWorld, ['api']);
  assert.ok(m.electron.ipcChannels['app:open']);
  assert.ok(m.network.hosts['api.example.com']);
});

test('runtime-built channels, schemes and webPreferences scoping', () => {
  const code = [
    'const PICK = "desktop:pick-folder";',
    'ipcMain.handle(channel, h);',
    'register({ channel: PICK, handler });',
    'function hookupIpc(namespace = "sentry-ipc") { ipcRenderer.send(ipcUtil.createKey("start")); }',
    'const PROD = "voyager";', 'const DEV = "voyager-dev";',
    'function getScheme(d) { return d ? DEV : PROD; }',
    'const scheme = getScheme(env.dev);',
    'app.setAsDefaultProtocolClient(scheme);',
    'protocol.registerSchemesAsPrivileged([{ scheme: PROD, privileges: {} }]);',
    'const schema = { webPreferences: Struct({ sandbox: NullOr(Boolean) }) };',
    'const o = { preload: true };',
    'new BrowserWindow({ webPreferences: { sandbox: true, nested: { a: 1 }, contextIsolation: true } });',
  ].join('\n');
  const s = scanFile(code, code);
  const m = (() => { const acc = createMapAcc(); addScan(acc, 'app/main.cjs', s); return finalizeMap(acc); })();
  assert.deepEqual(m.electron.ipcChannels['desktop:pick-folder'], ['ipcMain.wrapper']);
  assert.deepEqual(m.electron.ipcChannels['sentry-ipc.start'], ['ipcRenderer.send']);
  assert.equal(m.electron.dynamicIpc.length, 1);
  assert.ok(!Object.keys(m.electron.ipcChannels).some((k) => k.startsWith('<unresolved')));
  assert.deepEqual(m.electron.protocols.defaultProtocolClient, ['voyager-dev|voyager']);
  assert.deepEqual(m.electron.protocols.privilegedSchemes, ['voyager']);
  assert.deepEqual(s.flags.map((f) => `${f.flag}=${f.value}`), ['sandbox=true', 'contextIsolation=true']);
});

test('packageFromPath and classify', () => {
  assert.deepEqual(packageFromPath('../../node_modules/.pnpm/effect@3.1.0/node_modules/effect/dist/x.js'), { name: 'effect', version: '3.1.0' });
  assert.deepEqual(packageFromPath('../../node_modules/.pnpm/@sentry+core@8.0.0_x@1/node_modules/@sentry/core/a.js'), { name: '@sentry/core', version: '8.0.0' });
  assert.equal(classify('apps/desktop/dist-electron/preload.cjs', { regions: 0 }), 'preload');
  assert.equal(classify('apps/server/dist/client/assets/modulepreload-x.js', { regions: 0 }), 'browser-chunk');
  assert.equal(classify('apps/server/dist/bin.mjs', { regions: 3 }), 'node-bundle');
});

async function put(p, s) { await mkdir(dirname(p), { recursive: true }); await writeFile(p, s); }

test('end-to-end run on synthetic inDir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vre-03-'));
  try {
    const inDir = join(dir, 'in'), outDir = join(dir, 'out');
    await put(join(inDir, 'app/apps/desktop/dist-electron/main.cjs'),
      `const electron = require("electron");\n//#region src/ipc/DesktopIpc.ts\nconst CH = "win:close";\nelectron.ipcMain.handle(CH, () => 1);\n//#endregion\n//#region ../../node_modules/.pnpm/foo@1.2.3/node_modules/foo/dist/i.js\nmodule.exports = 1;\n//#endregion\n//#region ../../../../../../evil/../../../x.ts\nbad();\n//#endregion\n//# sourceMappingURL=main.cjs.map\n//# debugId=aaaaaaaa-bbbb\n`);
    await put(join(inDir, 'app/apps/desktop/dist-electron/preload.cjs'), `const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("desktop", { c: () => ipcRenderer.invoke("win:close") });\n`);
    await put(join(inDir, 'server/apps/server/dist/client/assets/index-abc.js'), `import{a as b}from"./x.js";${'var q=1;'.repeat(100)}fetch("https://api.moda.test/v1")`);
    await put(join(inDir, 'server/node_modules/bar/package.json'), '{"name":"bar","version":"9.9.9"}');
    await put(join(inDir, 'server/node_modules/bar/index.js'), 'module.exports=1');
    await assert.rejects(stage.run({ inDir: join(dir, 'missing'), outDir, log: quiet }), /02-asar/);
    await assert.rejects(stage.run({ inDir: null, outDir, log: quiet }));

    const res = await stage.run({ inDir, outDir, log: quiet });
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.outputs.slice(0, 3), ['index.json', 'map.json', 'REPORT.md']);
    for (const o of res.outputs) await stat(join(outDir, o));
    const idx = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
    assert.equal(idx.files.length, 3);
    const main = idx.files.find((f) => f.path.endsWith('main.cjs'));
    assert.equal(main.regions, 3);
    assert.deepEqual(main.imports, ['electron']);
    assert.equal(idx.files.find((f) => f.path.endsWith('index-abc.js')).minified, true);
    const rec = join(outDir, 'recovered/app/apps/desktop/dist-electron/main.cjs');
    assert.match(await readFile(join(rec, 'src/ipc/DesktopIpc.ts'), 'utf8'), /win:close/);
    assert.match(await readFile(join(rec, '_unregioned.js'), 'utf8'), /require\("electron"\)/);
    await assert.rejects(stat(join(dir, 'x.ts')));
    assert.ok(res.limits.some((l) => /rejected as unsafe/.test(l)));
    const map = JSON.parse(await readFile(join(outDir, 'map.json'), 'utf8'));
    assert.deepEqual(map.electron.ipcChannels['win:close'], ['ipcMain.handle', 'ipcRenderer.invoke']);
    assert.deepEqual(map.electron.exposeInMainWorld, ['desktop']);
    assert.ok(map.packages.find((p) => p.id === 'foo@1.2.3'));
    assert.ok(map.packages.find((p) => p.id === 'bar@9.9.9'));
    assert.ok(map.firstParty['app:src']);
    assert.ok(map.network.hosts['api.moda.test']);
    assert.deepEqual(map.debugIds, [{ file: 'app/apps/desktop/dist-electron/main.cjs', id: 'aaaaaaaa-bbbb' }]);
    const report = await readFile(join(outDir, 'REPORT.md'), 'utf8');
    assert.match(report, /## Electron security posture/);
    assert.match(report, /win:close/);
    if (idx.transforms.beautify) await stat(join(outDir, 'beautified/server/apps/server/dist/client/assets/index-abc.js'));
    else assert.ok(res.limits.some((l) => /beautify/.test(l)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
