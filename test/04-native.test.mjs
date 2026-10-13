import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import native, { roleOf } from '../stages/04-native/index.mjs';
import { bufferIO, capabilities, certNames, isPE, parsePE, parseVersionInfo, shannonEntropy, StringScanner, toolchains } from '../stages/04-native/lib/pe.mjs';

const quiet = () => {};

/** UTF-16LE string with NUL terminator. */
const w = (s) => Buffer.from(`${s}\0`, 'utf16le');
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

/** VS_VERSIONINFO block: header + key + padding + value + children. */
function verBlock(key, value, children = [], type = 0) {
  const head = Buffer.alloc(6);
  const k = pad4(Buffer.concat([head, w(key)]));
  const v = value ? pad4(value) : Buffer.alloc(0);
  const body = Buffer.concat([k, v, ...children.map(pad4)]);
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(value ? (type === 1 ? value.length / 2 : value.length) : 0, 2);
  body.writeUInt16LE(type, 4);
  return body;
}

function versionInfo() {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE((1 << 16) | 2, 8); fixed.writeUInt32LE((3 << 16) | 4, 12);
  fixed.writeUInt32LE((1 << 16) | 2, 16); fixed.writeUInt32LE((3 << 16) | 4, 20);
  const str = (k, v) => verBlock(k, w(v), [], 1);
  const table = verBlock('040904b0', null, [str('ProductName', 'Voyager'), str('CompanyName', 'Moda')], 1);
  return verBlock('VS_VERSION_INFO', fixed, [verBlock('StringFileInfo', null, [table], 1)]);
}

/** Minimal PE32+: .text (random, high entropy, with strings) and .rdata (imports + debug + version resource). */
function buildPE() {
  const buf = Buffer.alloc(0x1000);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('Rich', 0x70, 'latin1');
  buf.writeUInt32LE(0x4550, 0x80);
  buf.writeUInt16LE(0x8664, 0x84);
  buf.writeUInt16LE(2, 0x86);
  buf.writeUInt32LE(1700000000, 0x88);
  buf.writeUInt16LE(240, 0x94);
  buf.writeUInt16LE(0x22, 0x96);
  const opt = 0x98;
  buf.writeUInt16LE(0x20b, opt);
  buf.writeUInt32LE(0x1000, opt + 16);
  buf.writeBigUInt64LE(0x140000000n, opt + 24);
  buf.writeUInt32LE(0x200, opt + 60);
  buf.writeUInt16LE(3, opt + 68);
  buf.writeUInt16LE(0x4160, opt + 70);
  buf.writeUInt32LE(16, opt + 108);
  const dir = (i, rva, size) => { buf.writeUInt32LE(rva, opt + 112 + i * 8); buf.writeUInt32LE(size, opt + 116 + i * 8); };
  const sec = (i, name, vaddr, raw, size, chars) => {
    const o = opt + 240 + i * 40;
    buf.write(name, o, 'latin1');
    buf.writeUInt32LE(size, o + 8); buf.writeUInt32LE(vaddr, o + 12);
    buf.writeUInt32LE(size, o + 16); buf.writeUInt32LE(raw, o + 20);
    buf.writeUInt32LE(chars, o + 36);
  };
  sec(0, '.text', 0x1000, 0x200, 0x800, 0x60000020);
  sec(1, '.rdata', 0x2000, 0xa00, 0x600, 0x40000040);
  randomBytes(0x800).copy(buf, 0x200);
  buf.write('https://api.example.com/v1/telemetry\0', 0x300, 'latin1');
  w('\\\\.\\pipe\\voyager-ipc').copy(buf, 0x340);
  buf.write('/rustc/ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96/library/core\0', 0x400, 'latin1');
  // .rdata at file 0xa00 = rva 0x2000
  const at = (rva) => 0xa00 + rva - 0x2000;
  dir(1, 0x2000, 40);
  buf.writeUInt32LE(0x2040, at(0x2000)); buf.writeUInt32LE(0x2080, at(0x200c)); buf.writeUInt32LE(0x2040, at(0x2010));
  buf.writeBigUInt64LE(0x20a0n, at(0x2040));
  buf.writeBigUInt64LE(0x20c0n, at(0x2048));
  buf.writeBigUInt64LE((1n << 63n) | 7n, at(0x2050));
  buf.write('KERNEL32.dll\0', at(0x2080), 'latin1');
  buf.write('CreateProcessW\0', at(0x20a0) + 2, 'latin1');
  buf.write('CreateNamedPipeW\0', at(0x20c0) + 2, 'latin1');
  // debug directory -> RSDS
  dir(6, 0x2100, 28);
  buf.writeUInt32LE(2, at(0x2100) + 12); buf.writeUInt32LE(64, at(0x2100) + 16); buf.writeUInt32LE(at(0x2140), at(0x2100) + 24);
  buf.write('RSDS', at(0x2140), 'latin1');
  buf.write('C:\\build\\voyager_dictation.pdb\0', at(0x2140) + 24, 'latin1');
  // resources: root -> type 16 -> name 1 -> lang -> data entry
  const vi = versionInfo();
  dir(2, 0x2200, 0x300);
  const r = at(0x2200);
  const dirHdr = (o, entries) => { buf.writeUInt16LE(entries.length, o + 14); entries.forEach(([id, off], i) => { buf.writeUInt32LE(id, o + 16 + i * 8); buf.writeUInt32LE(off >>> 0, o + 20 + i * 8); }); };
  dirHdr(r, [[16, 0x80000000 | 0x18]]);
  dirHdr(r + 0x18, [[1, 0x80000000 | 0x30]]);
  dirHdr(r + 0x30, [[0x409, 0x48]]);
  buf.writeUInt32LE(0x2300, r + 0x48); buf.writeUInt32LE(vi.length, r + 0x4c);
  vi.copy(buf, at(0x2300));
  return buf;
}

test('04: parses headers, sections, imports, debug info, version resource', () => {
  const pe = buildPE();
  assert.ok(isPE(pe));
  assert.equal(isPE(Buffer.from('MZ not a pe at all, just text that is long enough to have a header....')), false);
  const r = parsePE(bufferIO(pe));
  assert.deepEqual(r.errors, []);
  assert.equal(r.machine, 'x64');
  assert.equal(r.format, 'PE32+');
  assert.equal(r.subsystem, 'windows-cui');
  assert.equal(r.imageBase, 0x140000000);
  assert.deepEqual(r.dllCharacteristics, ['high-entropy-va', 'aslr', 'dep', 'cfg']);
  assert.deepEqual(r.sections.map((s) => s.name), ['.text', '.rdata']);
  assert.deepEqual(r.imports, [{ dll: 'KERNEL32.dll', functions: ['CreateProcessW', 'CreateNamedPipeW', '#7'] }]);
  assert.equal(r.pdb, 'C:\\build\\voyager_dictation.pdb');
  assert.ok(r.rich);
  assert.equal(r.version.fileVersion, '1.2.3.4');
  assert.deepEqual(r.version.strings, { ProductName: 'Voyager', CompanyName: 'Moda' });
  assert.equal(r.security, null);
  const caps = capabilities(r.imports);
  assert.deepEqual(caps['process-control'], ['kernel32.dll!CreateProcessW']);
  assert.deepEqual(caps['named-pipes'], ['kernel32.dll!CreateNamedPipeW']);
});

test('04: entropy, strings and toolchain detection', () => {
  assert.equal(shannonEntropy(Buffer.alloc(1000)), 0);
  assert.ok(shannonEntropy(randomBytes(65536)) > 7.9);
  const pe = buildPE();
  const s = new StringScanner();
  s.feed(pe.subarray(0, 0x350)); // split mid-file: scanner must carry state across chunks
  s.feed(pe.subarray(0x350));
  const out = s.finish();
  assert.deepEqual(out.interesting.url, ['https://api.example.com/v1/telemetry']);
  assert.deepEqual(out.interesting.pipe, ['\\\\.\\pipe\\voyager-ipc']);
  assert.deepEqual(toolchains(out.interesting.toolchain, null), ['Rust (rustc commit ac68faa20c58)']);
  assert.deepEqual(toolchains([], 'C:\\x\\electron.exe.pdb'), ['Electron (Chromium)']);
});

test('04: certificate subject names and signer heuristic', () => {
  const name = (attr, s) => Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x04, attr, 0x0c, s.length]), Buffer.from(s)]);
  const blob = Buffer.concat([name(3, 'DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1'), name(3, 'Microsoft Code Signing PCA 2010'), name(3, 'Cua AI, Inc.'), name(10, 'Cua AI, Inc.'), name(3, 'DigiCert Timestamp 2023')]);
  const c = certNames(blob);
  assert.equal(c.signer, 'Cua AI, Inc.');
  assert.deepEqual(c.organizations, ['Cua AI, Inc.']);
  assert.equal(c.commonNames.length, 4);
});

test('04: version info parser rejects other blobs', () => {
  assert.throws(() => parseVersionInfo(verBlock('NOPE', null)));
});

test('04: roles', () => {
  assert.equal(roleOf('app/Voyager.exe'), 'electron-host');
  assert.equal(roleOf('nsis/$R0/Uninstall Voyager.exe'), 'installer-helper');
  assert.equal(roleOf('app/resources/dictation/voyager-dictation.exe'), 'voyager-helper');
  assert.equal(roleOf('app/resources/x/node_modules/a/b.node'), 'native-module');
  assert.equal(roleOf('app/ffmpeg.dll'), 'electron-runtime');
  assert.equal(roleOf('app/resources/engines/video/bin/avcodec.dll'), 'bundled-tool');
});

test('04: stage run on a synthetic tree, deduping identical copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vre-'));
  try {
    const outDir = join(root, '04-native');
    await assert.rejects(native.run({ outDir, manifest: { entries: [] }, log: quiet }), /run 01-installer first/);
    const app = join(root, '01-installer', 'app');
    await mkdir(join(app, 'resources', 'dictation'), { recursive: true });
    await mkdir(join(root, '02-asar', 'app'), { recursive: true });
    await mkdir(outDir);
    const pe = buildPE();
    await writeFile(join(app, 'resources', 'dictation', 'voyager-dictation.exe'), pe);
    await writeFile(join(root, '02-asar', 'app', 'copy.node'), pe);
    await writeFile(join(app, 'readme.txt'), 'x'.repeat(2000));
    const res = await native.run({ outDir, manifest: { entries: [{ stage: '01-installer', status: 'ok' }] }, log: quiet });
    assert.equal(res.status, 'ok');
    const idx = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf8'));
    assert.equal(idx.binaries.length, 1);
    assert.deepEqual(idx.binaries[0].copies, ['02-asar/app/copy.node']);
    assert.deepEqual(idx.binaries[0].toolchains, ['Rust (rustc commit ac68faa20c58)']);
    const report = await readFile(join(outDir, 'REPORT.md'), 'utf8');
    assert.match(report, /voyager-dictation\.exe/);
    assert.match(report, /voyager_dictation\.pdb/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
