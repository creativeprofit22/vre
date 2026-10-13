// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addScan, createMapAcc, finalizeMap, scanFile } from '../stages/03-js/lib/map.mjs';
import { surfaceSection } from '../stages/03-js/lib/report.mjs';
import { addonBasePackage, bridgeMembers, objectProps, scanRoutes, scanRpc, senderChecks } from '../stages/03-js/lib/surface.mjs';

test('objectProps handles nesting, strings, spreads and method shorthand', () => {
  const props = objectProps(`a: 1, "b-c": f(1, 2), ...REST, d: { e: "x,y" }, g(x) { return [x, 1]; }, h: \`t\${{ k: 1 }.k}\``);
  assert.deepEqual(props.map((p) => p.key), ['a', 'b-c', 'REST', 'd', 'g', 'h']);
  assert.equal(props[2].spread, true);
  assert.equal(props[3].value, '{ e: "x,y" }');
});

test('scanRoutes finds served and called routes, not file paths', () => {
  const code = `
    router.add("GET", "/health", h); add$5("*", "/mcp/integrations", g);
    const T = layerHttp({ name: "V", path: "/mcp", protocols: [] });
    http.createServer((req, res) => { if (req.method !== "POST" || req.url !== "/control") return; });
    request({ socketPath: s, path: "/vm", method: "POST", headers: {} });
    const ops = { createJob: { method: "POST", path: "/render/jobs", query: [] } };
    client.delete({ url: "/mcp/{name}/auth", ...o });
    const me = await request("/v1/voyager/me");
    fetch(\`\${origin}/v1/credits\`);
    fs.readFile({ path: "/etc/hosts" });
  `;
  const r = scanRoutes(code).map((x) => `${x.kind} ${x.method} ${x.path}`);
  for (const want of ['serve GET /health', 'serve * /mcp/integrations', 'serve * /mcp', 'serve POST /control', 'call POST /vm', 'call POST /render/jobs', 'call DELETE /mcp/{name}/auth', 'call * /v1/voyager/me', 'call * /v1/credits']) {
    assert.ok(r.includes(want), `missing ${want} in ${r.join(' | ')}`);
  }
  assert.ok(!r.some((x) => x.includes('/etc/hosts')), 'a plain path option without method/socket is not a route');
});

test('scanRpc reads method tables with spreads and JSON-RPC literals, skipping MIME types', () => {
  const code = `const MINI_METHODS = { a: "mini.a" };
    const WS_METHODS = { ...MINI_METHODS, list: "projects.list", "thread/start": "thread/start", n: 3 };
    send({ method: "turn/start" }); x = { method: Literal("tools/call") }; y = { method: "image/png" };`;
  const { tables, jsonRpc } = scanRpc(code);
  assert.deepEqual(tables.find((t) => t.name === 'WS_METHODS'), { name: 'WS_METHODS', methods: ['projects.list', 'thread/start'], spreads: ['MINI_METHODS'] });
  assert.deepEqual(jsonRpc, ['tools/call', 'turn/start']);
  const acc = createMapAcc();
  addScan(acc, 'app/x.cjs', scanFile(code));
  const ws = finalizeMap(acc).surface.rpcTables.find((t) => t.name === 'WS_METHODS');
  assert.deepEqual(ws?.methods, ['mini.a', 'projects.list', 'thread/start']);
});

test('bridgeMembers flattens nested members and maps them to known IPC channels', () => {
  const code = `const OPEN_CHANNEL = "desktop:open"; const OTHER_CONST = "not-a-channel";
    electron.ipcMain.handle(OPEN_CHANNEL, f);
    electron.contextBridge.exposeInMainWorld("desktopBridge", {
      getPath: (f) => webUtils.getPathForFile(f),
      files: { open: (p) => electron.ipcRenderer.invoke(OPEN_CHANNEL, p), label: () => OTHER_CONST },
      raw: () => electron.ipcRenderer.send("desktop:raw"),
    });
    const api = { ping: () => 1 }; electron.contextBridge.exposeInMainWorld("other", api);`;
  const consts = new Map([['OPEN_CHANNEL', 'desktop:open'], ['OTHER_CONST', 'not-a-channel']]);
  const b = bridgeMembers(code, consts);
  assert.deepEqual(b.map((x) => [x.api, x.members.map((m) => m.path)]), [['desktopBridge', ['getPath', 'files.open', 'files.label', 'raw']], ['other', ['ping']]]);
  const acc = createMapAcc();
  addScan(acc, 'app/preload.cjs', scanFile(code));
  const db = finalizeMap(acc).surface.bridges.find((x) => x.api === 'desktopBridge');
  assert.deepEqual(db?.members.find((m) => m.path === 'files.open')?.channels, ['desktop:open']);
  assert.deepEqual(db?.members.find((m) => m.path === 'files.label')?.channels, [], 'non-channel constants are dropped');
});

test('senderChecks counts frame comparisons, URL reads and helper calls but not definitions', () => {
  const code = `function ensureTrustedSender(e) {} ipcMain.handle(C, (e) => { ensureTrustedSender(e); if (e.senderFrame !== win.webContents.mainFrame) return; log(e.senderFrame.url, e.sender.getURL()); });`;
  const c = Object.fromEntries(senderChecks(code).map((x) => [x.name, x.count]));
  assert.deepEqual(c, { ensureTrustedSender: 1, 'senderFrame comparison': 1, 'senderFrame.url': 1, 'sender.getURL()': 1 });
});

test('native addons link prebuilt packages to importing bundles; report renders the section', () => {
  assert.equal(addonBasePackage('@napi-rs/keyring-win32-x64-msvc'), '@napi-rs/keyring');
  assert.equal(addonBasePackage('node-pty'), 'node-pty');
  const acc = createMapAcc();
  acc.addonFiles.push({ archive: 'app', path: 'node_modules/@yuuang/ffi-rs-win32-x64-msvc/ffi-rs.node', package: '@yuuang/ffi-rs-win32-x64-msvc', bytes: 10 });
  acc.addonFiles.push({ archive: 'app', path: 'node_modules/@ubjs/node-win32-x64-msvc/u.node', package: '@ubjs/node-win32-x64-msvc', bytes: 5 });
  acc.imports.set('app/main.cjs', ['ffi-rs', 'electron']);
  addScan(acc, 'app/main.cjs', scanFile('const a = require("./x.node"); router.add("GET", "/health", h);'));
  const s = finalizeMap(acc).surface;
  assert.deepEqual(s.nativeAddons.files.map((a) => [a.loader, a.importedBy]), [['@ubjs/node', []], ['@yuuang/ffi-rs', ['app/main.cjs']]]);
  assert.deepEqual(s.nativeAddons.loads, [{ file: 'app/main.cjs', requires: ['./x.node'], dlopen: 0 }]);
  const md = surfaceSection(s).join('\n');
  assert.match(md, /## Callable surface/);
  assert.match(md, /\| GET \| `\/health` \| router \| main\.cjs \|/);
  assert.match(md, /no direct first-party import/);
});

test('channelSenderChecks reports per-channel coverage through inline checks, shared guards, named handlers and wrappers', () => {
  const code = `
const CH_A = "app:a";
const CH_B = "app:b";
const CH_C = "app:c";
const CH_D = "app:d";
const CH_E = "app:e";
const ensureMainSender = (event) => { if (event.sender.id !== main.webContents.id) throw new Error("x"); };
const onMsg = (event) => { if (event.senderFrame !== win.webContents.mainFrame) return; };
ipcMain.handle(CH_A, (event) => { ensureMainSender(event); return 1; });
ipcMain.on(CH_B, onMsg);
ipcMain.on(CH_C, (event, x) => log(x));
ipcMain.handle(channel, (event, raw) => run(raw));
const methods = [makeIpcMethod({ channel: CH_D, handler: (input, event) => ensureMainSender(event) }), makeIpcMethod({ channel: CH_E, handler: (input) => input })];`;
  const acc = createMapAcc();
  addScan(acc, 'app/main.cjs', scanFile(code));
  const cov = finalizeMap(acc).surface.ipcSenderCoverage;
  const by = Object.fromEntries(cov.channels.map((r) => [r.channel, r.via]));
  assert.deepEqual(by, { 'app:a': 'helper ensureMainSender', 'app:b': 'handler onMsg', 'app:c': null, 'app:d': 'helper ensureMainSender', 'app:e': null });
  assert.equal(cov.checked, 3);
  assert.equal(cov.total, 5);
  assert.deepEqual(cov.wrappers.map((w) => [w.raw, w.checked]), [['channel', false]]);
  const md = surfaceSection(finalizeMap(acc).surface).join('\n');
  assert.match(md, /3 of 5 channels checked/);
  assert.match(md, /\| `app:c` \| main\.cjs \| on \| no \| - \|/);
});
