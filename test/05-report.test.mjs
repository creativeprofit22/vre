// @ts-check
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import stage from '../stages/05-report/index.mjs';
import { parseFlatYaml, PROBES, runProbes } from '../stages/05-report/lib/summary.mjs';

const put = async (/** @type {string} */ p, /** @type {string} */ s) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, s); };

test('probes cite file and offset, and unmatched probes make no claim', () => {
  const code = 'x; env: { ELECTRON_RUN_AS_NODE: "1" }; args: [ entry, "--bootstrap-fd", "3" ]';
  const r = runProbes([{ file: 'main.cjs', code }]);
  assert.equal(r.length, PROBES.length);
  const node = r.find((p) => p.id === 'backend-node-mode');
  assert.equal(node?.file, 'main.cjs');
  assert.equal(node?.offset, code.indexOf('ELECTRON_RUN_AS_NODE'));
  assert.equal(r.find((p) => p.id === 'dictation-sidecar')?.file, null);
});

test('parseFlatYaml reads app-update.yml style files', () => {
  assert.deepEqual(parseFlatYaml('owner: usevoyager\nrepo: "voyager-releases"\r\nprovider: github\n# c\n'), { owner: 'usevoyager', repo: 'voyager-releases', provider: 'github' });
});

test('05-report fails without 03/04 output and writes a cited summary when present', async () => {
  const out = await mkdtemp(join(tmpdir(), 'vre05-'));
  try {
    const outDir = join(out, '05-report');
    await mkdir(outDir, { recursive: true });
    await assert.rejects(stage.run({ outDir, manifest: { entries: [] }, log() {} }), /needs 03-js\/map\.json, 04-native\/index\.json/);

    await put(join(out, '02-asar/app/package.json'), JSON.stringify({ name: 'demo', version: '1.2.3', main: 'dist/main.cjs' }));
    await put(join(out, '02-asar/app/dist/main.cjs'), 'const env = { ELECTRON_RUN_AS_NODE: "1" }; w.setWindowOpenHandler(() => ({ action: "deny" }));');
    await put(join(out, '01-installer/app/resources/app-update.yml'), 'owner: acme\nrepo: demo-releases\nprovider: github\n');
    await put(join(out, '03-js/map.json'), JSON.stringify({
      packages: [{ name: 'x' }], firstParty: { 'app:src': ['src/a.ts', 'src/b.ts'] },
      electron: { ipcChannels: { 'demo:ping': {} }, dynamicIpc: [], webPreferences: [{ flag: 'contextIsolation', value: 'true' }], protocols: [], openExternal: [], calls: {}, exposeInMainWorld: [] },
      network: { hosts: { 'api.demo.test': ['https://api.demo.test/v1'] }, urlCount: 1 }, env: [], debugIds: [], sourceMaps: [],
      surface: {
        routes: [{ kind: 'serve', method: 'GET', path: '/ws', via: ['router'], files: ['server/x.mjs'] }],
        rpcTables: [{ name: 'WS_METHODS', methods: ['a.b', 'c.d'], includes: [], files: ['server/x.mjs'] }],
        jsonRpc: { 'thread/start': ['server/x.mjs'] },
        bridges: [{ api: 'demoBridge', file: 'app/preload.cjs', members: [{ path: 'ping', channels: ['demo:ping'] }] }],
        senderChecks: [{ file: 'app/main.cjs', kind: 'frame', name: 'senderFrame comparison', count: 2 }],
        nativeAddons: { files: [], loads: [] },
      },
    }));
    await put(join(out, '04-native/index.json'), JSON.stringify({ binaries: [{
      path: '01-installer/app/Demo.exe', role: 'electron-host', size: 1 << 20, machine: 'x64', timestampIso: '2026-01-01T00:00:00.000Z', signature: null,
      version: { strings: { ProductName: 'Demo', FileVersion: '1.2.3' } }, toolchains: ['Electron (Chromium)'], packedSections: [],
      strings: { interesting: { toolchain: ['Chrome/150.0.1.2 Electron/40.1.0'] } },
    }], engines: {} }));
    const res = await stage.run({ outDir, manifest: { entries: [{ stage: '03-js', status: 'ok', notes: ['n1'] }] }, log() {} });
    assert.equal(res.status, 'ok');
    assert.deepEqual(res.outputs, ['REPORT.md', 'probes.json']);
    const md = await readFile(join(outDir, 'REPORT.md'), 'utf8');
    assert.match(md, /\| Product \| Demo 1\.2\.3 \|/);
    assert.match(md, /Electron 40\.1\.0 \(Chromium 150\.0\.1\.2\)/);
    assert.match(md, /github `acme\/demo-releases`/);
    assert.match(md, /ELECTRON_RUN_AS_NODE=1.*evidence: `02-asar\/app\/dist\/main\.cjs` @ \d+/);
    assert.match(md, /Probes with no match \(claims not made\):.*`dictation-sidecar`/);
    assert.match(md, /`window\.demoBridge` .* 1 members, 1 IPC channels/);
    assert.match(md, /`WS_METHODS` over WebSocket `GET \/ws` \| 2 methods/);
    assert.match(md, /\| 03-js \| ok \| n1 \|/);
    const probes = JSON.parse(await readFile(join(outDir, 'probes.json'), 'utf8'));
    assert.equal(probes.filter((/** @type {any} */ p) => p.file).length, 2);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
