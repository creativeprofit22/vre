import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { decodeNsisHeader, readNsisHeader } from '../stages/01-installer/lib/nsis-script.mjs';

/** Build a minimal NSIS 3 Unicode installer: stub + firstheader + deflated header. */
function fixture() {
  // string table (UTF-16LE, offsets in chars); "$INSTDIR\App.exe" uses NS_VAR_CODE (3) + var 21
  const parts = ['', 'Software\\Classes\\vy', 'URL Protocol', '', 'DisplayName', 'Voyager', null, 'System.dll', 'Call', '$SMPROGRAMS\\Voyager.lnk'];
  const chunks = [];
  const offs = [];
  let at = 0;
  for (const p of parts) {
    offs.push(at);
    let b;
    if (p === null) b = Buffer.concat([Buffer.from([3, 0, 21, 0x80]), Buffer.from('\\App.exe', 'utf16le')]);
    else if (p.startsWith('$SMPROGRAMS')) b = Buffer.concat([Buffer.from([2, 0, 0x17, 0x17]), Buffer.from(p.slice(11), 'utf16le')]);
    else b = Buffer.from(p, 'utf16le');
    chunks.push(b, Buffer.alloc(2));
    at += b.length / 2 + 1;
  }
  const strs = Buffer.concat(chunks);
  const s = (/** @type {number} */ i) => offs[i];
  const ents = [
    [51, 0x80000001, s(1), s(2), s(3), 1, 1],         // WriteRegStr HKCU Software\Classes\vy "URL Protocol" ""
    [51, 0x80000002, s(4), s(4), s(5), 1, 2],         // WriteRegExpandStr HKLM ...
    [45, s(9), s(6), 0, s(6), 0, 0],                  // CreateShortcut
    [44, s(7), s(8), 0, 0, 0, 0],                     // plugin System::Call
    [50, 0, 0x80000001, s(1), 0, 1, 0],              // DeleteRegKey HKCU Software\Classes\vy
    [1, 0, 0, 0, 0, 0, 0],                            // Return
  ];
  const entries = Buffer.alloc(ents.length * 28);
  ents.forEach((e, k) => e.forEach((v, j) => entries.writeInt32LE(v | 0, k * 28 + j * 4)));
  const fixed = 300;
  const header = Buffer.alloc(fixed);
  const blocks = [[fixed, 0], [fixed, 0], [fixed, ents.length], [fixed + entries.length, 1], [fixed + entries.length + strs.length, 0]];
  blocks.forEach(([o, n], b) => { header.writeInt32LE(o, 4 + b * 8); header.writeInt32LE(n, 8 + b * 8); });
  for (let k = 0; k < 10; k++) header.writeInt32LE(-1, 68 + 36 + k * 4); // no callbacks
  const full = Buffer.concat([header, entries, strs]);
  const comp = deflateRawSync(full);
  const fh = Buffer.alloc(28 + 4);
  fh.writeUInt32LE(0, 0); fh.writeUInt32LE(0xdeadbeef, 4); fh.write('NullsoftInst', 8, 'latin1');
  fh.writeUInt32LE(full.length, 20); fh.writeUInt32LE(0, 24); fh.writeUInt32LE((comp.length | 0x80000000) >>> 0, 28);
  return Buffer.concat([Buffer.from('MZ' + '\0'.repeat(510), 'latin1'), fh, comp]);
}

test('NSIS header decoder recovers registry, protocol, shortcut and plugin calls from a synthetic installer', () => {
  const h = readNsisHeader(fixture());
  assert.equal(h.compression, 'deflate');
  assert.equal(h.uninstaller, false);
  const d = decodeNsisHeader(h.header);
  assert.equal(d.meta.instructions, 6);
  assert.deepEqual(d.effects.registry[0], { op: 'WriteRegStr', key: 'HKCU\\Software\\Classes\\vy', name: 'URL Protocol', value: '' });
  assert.equal(d.effects.registry[1].op, 'WriteRegExpandStr');
  assert.equal(d.effects.registry[1].value, 'Voyager');
  assert.deepEqual(d.effects.registry[2], { op: 'DeleteRegKey', key: 'HKCU\\Software\\Classes\\vy' });
  assert.deepEqual(d.effects.protocols, ['vy']);
  assert.deepEqual(d.effects.shortcuts, [{ link: '$SMPROGRAMS\\Voyager.lnk', target: '$INSTDIR\\App.exe', args: '', icon: '$INSTDIR\\App.exe' }]);
  assert.deepEqual(d.effects.plugins, ['System::Call']);
  assert.match(d.script, /Return/);
});

test('NSIS header decoder rejects LZMA headers honestly', () => {
  const buf = fixture();
  const at = buf.indexOf('NullsoftInst', 0, 'latin1') + 20 + 4;
  buf[at] = 0x5d;
  assert.throws(() => readNsisHeader(buf), /LZMA/);
});
