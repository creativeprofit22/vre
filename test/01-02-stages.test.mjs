import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import installer, { find7z, findNsisSignature } from '../stages/01-installer/index.mjs';
import asarStage, { extractAsar } from '../stages/02-asar/index.mjs';
import { listEntries, safeSegment } from '../stages/02-asar/lib/asar.mjs';

const quiet = () => {};
const tmp = () => mkdtemp(join(tmpdir(), 'vre-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Build an asar file. files: { 'a/b.txt': Buffer|string | { unpacked: true, data } }. */
function buildAsar(files, { corrupt } = {}) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [path, v] of Object.entries(files)) {
    const parts = path.split('/');
    let node = root;
    for (const p of parts.slice(0, -1)) node = (node.files[p] ??= { files: {} });
    const unpacked = typeof v === 'object' && !Buffer.isBuffer(v) && v.unpacked;
    const data = Buffer.from(unpacked ? v.data : v);
    const integrity = { algorithm: 'SHA256', hash: sha(data), blockSize: 4194304, blocks: [sha(data)] };
    if (unpacked) node.files[parts.at(-1)] = { size: data.length, unpacked: true, integrity };
    else {
      node.files[parts.at(-1)] = { size: data.length, offset: String(offset), integrity };
      chunks.push(corrupt === path ? Buffer.from(data.map((x) => x ^ 1)) : data);
      offset += data.length;
    }
  }
  const json = Buffer.from(JSON.stringify(root));
  const pad = (4 - (json.length % 4)) % 4;
  const pickle = Buffer.alloc(8 + json.length + pad);
  pickle.writeUInt32LE(4 + json.length + pad, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const pre = Buffer.alloc(8);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([pre, pickle, ...chunks]);
}

test('01: NSIS signature and 7-Zip discovery', async () => {
  assert.equal(findNsisSignature(Buffer.from('xx\xef\xbe\xad\xdeNullsoftInst', 'latin1')), 6);
  assert.equal(findNsisSignature(Buffer.from('MZ nothing')), -1);
  assert.equal(find7z({ VRE_7Z: 'definitely-not-a-real-7z-binary' }), null);
});

test('01: rejects missing, non-PE and non-NSIS inputs', async () => {
  const dir = await tmp();
  try {
    const run = (input) => installer.run({ outDir: dir, input, log: quiet });
    await assert.rejects(run(null), /--input/);
    await assert.rejects(run(join(dir, 'missing.exe')), /not found/);
    await writeFile(join(dir, 'a.exe'), 'hello');
    await assert.rejects(run(join(dir, 'a.exe')), /not a Windows PE/);
    await writeFile(join(dir, 'b.exe'), Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]));
    await assert.rejects(run(join(dir, 'b.exe')), /not an NSIS installer/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('02: asar names that escape the folder are rejected', () => {
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'x\0']) assert.throws(() => safeSegment(bad));
  assert.throws(() => listEntries({ files: { '..': { files: { 'evil.js': { size: 1, offset: '0' } } } } }));
  assert.equal(listEntries({ files: { a: { files: { 'b.js': { size: 1, offset: '0' } } }, l: { link: 'a/b.js' } } }).length, 3);
});

test('02: extracts packed and unpacked files and verifies integrity', async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, 'app.asar'), buildAsar({ 'package.json': '{"name":"x"}', 'dist/main.js': 'console.log(1)\n', 'bin/n.node': { unpacked: true, data: 'NATIVE' } }));
    await mkdir(join(dir, 'app.asar.unpacked', 'bin'), { recursive: true });
    await writeFile(join(dir, 'app.asar.unpacked', 'bin', 'n.node'), 'NATIVE');
    const r = await extractAsar(join(dir, 'app.asar'), join(dir, 'out'));
    assert.equal(r.files, 3);
    assert.equal(r.unpacked, 1);
    assert.equal(r.integrity.ok, 2);
    assert.equal(await readFile(join(dir, 'out', 'dist', 'main.js'), 'utf8'), 'console.log(1)\n');
    assert.equal(await readFile(join(dir, 'out', 'bin', 'n.node'), 'utf8'), 'NATIVE');

    await writeFile(join(dir, 'bad.asar'), buildAsar({ 'a.js': 'abc' }, { corrupt: 'a.js' }));
    const b = await extractAsar(join(dir, 'bad.asar'), join(dir, 'out2'));
    assert.deepEqual(b.integrity.failed, ['a.js']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('02: stage finds archives, writes index.json, and fails on integrity mismatch', async () => {
  const dir = await tmp();
  try {
    const inDir = join(dir, '01'), outDir = join(dir, '02');
    await mkdir(join(inDir, 'app', 'resources'), { recursive: true });
    await mkdir(outDir);
    await writeFile(join(inDir, 'app', 'resources', 'app.asar'), buildAsar({ 'main.js': '1' }));
    await writeFile(join(inDir, 'app', 'resources', 'server.asar'), buildAsar({ 'bin.mjs': '2' }));
    const res = await asarStage.run({ inDir, outDir, log: quiet });
    assert.equal(res.status, 'ok');
    const idx = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
    assert.deepEqual(idx.archives.map((a) => [a.name, a.source]), [['app', 'app/resources/app.asar'], ['server', 'app/resources/server.asar']]);
    assert.equal(await readFile(join(outDir, 'server', 'bin.mjs'), 'utf8'), '2');

    await writeFile(join(inDir, 'app', 'resources', 'app.asar'), buildAsar({ 'main.js': 'xyz' }, { corrupt: 'main.js' }));
    assert.equal((await asarStage.run({ inDir, outDir, log: quiet })).status, 'failed');
    await assert.rejects(asarStage.run({ inDir: join(dir, 'nope'), outDir, log: quiet }), /run 01-installer first/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
