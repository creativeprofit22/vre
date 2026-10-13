// @ts-check
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { BUN_TRAILER, parseBunGraph, rustSources, safeModulePath } from '../stages/04-native/lib/embedded.mjs';
import { embeddedSection } from '../stages/04-native/lib/report.mjs';

/**
 * Build a synthetic Bun standalone payload: [data][offsets 32 B][trailer].
 * @param {{ name: string, body: string }[]} files @param {number} entry @param {string} argv
 */
function bunBlob(files, entry, argv) {
  /** @type {Buffer[]} */
  const parts = [];
  let off = 0;
  const put = (/** @type {Buffer} */ b) => { const at = off; parts.push(b); off += b.length; return at; };
  const recs = files.map((f) => {
    const n = Buffer.from(f.name), c = Buffer.from(f.body);
    return { no: put(n), nl: n.length, co: put(c), cl: c.length };
  });
  const ao = put(Buffer.from(argv));
  const table = Buffer.alloc(52 * recs.length);
  recs.forEach((r, i) => {
    const o = i * 52;
    table.writeUInt32LE(r.no, o); table.writeUInt32LE(r.nl, o + 4);
    table.writeUInt32LE(r.co, o + 8); table.writeUInt32LE(r.cl, o + 12);
    table.writeUInt8(1, o + 48); table.writeUInt8(1, o + 49); table.writeUInt8(1, o + 50);
  });
  const mo = put(table);
  const offsets = Buffer.alloc(32);
  offsets.writeBigUInt64LE(BigInt(off), 0);
  offsets.writeUInt32LE(mo, 8); offsets.writeUInt32LE(table.length, 12); offsets.writeUInt32LE(entry, 16);
  offsets.writeUInt32LE(ao, 20); offsets.writeUInt32LE(Buffer.byteLength(argv), 24); offsets.writeUInt32LE(15, 28);
  return Buffer.concat([Buffer.alloc(64, 0x90), ...parts, offsets, BUN_TRAILER, Buffer.alloc(100)]);
}

test('parseBunGraph reads the module table, entry point and baked-in argv', () => {
  const buf = bunBlob([
    { name: 'B:/~BUN/root/chunk-abc123.js', body: 'export const a = 1;' },
    { name: 'B:/~BUN/root/src/index.js', body: '// @bun\nimport { a } from "./chunk-abc123.js";' },
    { name: 'B:/~BUN/root/../../node_modules/x/worker.js', body: 'postMessage(1)' },
  ], 1, '--user-agent=tool/1.2.3 --');
  const g = parseBunGraph(buf);
  assert.ok(g);
  assert.equal(g.entryPoint, 'src/index.js');
  assert.equal(g.execArgv, '--user-agent=tool/1.2.3 --');
  assert.equal(g.recordSize, 52);
  assert.deepEqual(g.modules.map((m) => m.path), ['chunk-abc123.js', 'src/index.js', '../../node_modules/x/worker.js']);
  const idx = g.modules[1];
  assert.equal(buf.subarray(idx.offset, idx.offset + idx.size).toString(), '// @bun\nimport { a } from "./chunk-abc123.js";');
  assert.equal(parseBunGraph(Buffer.from('no trailer here')), null);
});

test('safeModulePath never escapes the output folder', () => {
  assert.equal(safeModulePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeModulePath('a\\b:c/d?.js'), 'a/b_c/d_.js');
  assert.equal(safeModulePath('../..'), null);
});

test('rustSources finds deps, git deps, first-party crates, CI repo and rustc commit', () => {
  const text = [
    'C:\\Users\\runneradmin\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\serde_json-1.0.151\\src\\error.rs',
    'C:\\Users\\runneradmin\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\whisper-rs-0.16.0\\src\\lib.rs',
    'C:\\Users\\runneradmin\\.cargo\\git\\checkouts\\engine-spec-31a8e026f366f4f6\\7592597\\src\\time\\rate.rs',
    'crates\\video-cache\\src\\flow.rs', 'crates/video-cache/src/flow.rs', 'crates\\video-cli\\src\\cli.rs', 'https://example.com/src/x.rs',
    'D:\\a\\daw\\daw\\target\\release\\build\\x\\out\\gen.rs',
    '/rustc/ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96/library/core/src/fmt/mod.rs',
  ].join('\0');
  const r = rustSources(text);
  assert.deepEqual(r.crates, [{ name: 'serde_json', versions: ['1.0.151'] }, { name: 'whisper-rs', versions: ['0.16.0'] }]);
  assert.deepEqual(r.git, [{ name: 'engine-spec', revs: ['7592597'] }]);
  assert.deepEqual(r.sources, ['crates/video-cache/src/flow.rs', 'crates/video-cli/src/cli.rs']);
  assert.deepEqual(r.sourceRoots, [{ root: 'crates/video-cache', files: 1 }, { root: 'crates/video-cli', files: 1 }]);
  assert.deepEqual(r.ciRepos, ['daw']);
  assert.deepEqual(r.rustc, ['ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96']);
  const md = embeddedSection([{ path: '01-installer/app/x.exe', rust: { ...r, sourceCount: r.sources.length } }]).join('\n');
  assert.match(md, /\| x\.exe \| daw \| 2 \| video-cache \(1\), video-cli \(1\) \| 2 \/ engine-spec@7592597 \| ac68faa20c58 \|/);
  assert.match(md, /whisper-rs 0\.16\.0/);
});
