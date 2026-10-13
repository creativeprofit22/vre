// Read-only Electron fuse wire reader (layout per github.com/electron/fuses src/index.ts):
// SENTINEL, then [version byte][wire length byte][one byte per fuse: '0' off, '1' on, 'r' removed].
// We never flip fuses; we only assert the ones that would block a modded app.asar are off.
import { open } from 'node:fs/promises';

export const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];
/** Fuses that must be OFF for a repacked/modified app.asar to load. */
export const MUST_BE_OFF = ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar'];

const STATE = { 0x30: 'off', 0x31: 'on', 0x72: 'removed' };

/** Parse the fuse wire that follows the sentinel at `pos` in `buf`. */
export function parseWire(buf, pos) {
  const at = pos + SENTINEL.length;
  const version = buf[at];
  const length = buf[at + 1];
  if (version === undefined || length === undefined || at + 2 + length > buf.length) throw new Error('truncated fuse wire');
  const fuses = {};
  for (let i = 0; i < length; i++) fuses[FUSE_NAMES[i] ?? `fuse${i}`] = STATE[buf[at + 2 + i]] ?? `unknown(0x${buf[at + 2 + i].toString(16)})`;
  return { version, length, fuses };
}

/** Find the fuse wire in a whole-file buffer (tests) . */
export function parseFuses(buf) {
  const pos = buf.indexOf(SENTINEL);
  if (pos < 0) throw new Error('no Electron fuse sentinel found (not an Electron >= 12 binary?)');
  return parseWire(buf, pos);
}

/** Stream-scan an executable for the fuse wire without loading it whole. */
export async function readFuses(exePath) {
  const fh = await open(exePath, 'r');
  try {
    const CHUNK = 4 << 20;
    const overlap = SENTINEL.length + 2 + 255;
    const buf = Buffer.allocUnsafe(CHUNK + overlap);
    const { size } = await fh.stat();
    for (let start = 0; start < size; start += CHUNK) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK + overlap, size - start), start);
      const view = buf.subarray(0, bytesRead);
      const pos = view.indexOf(SENTINEL);
      if (pos >= 0 && pos < CHUNK) return { offset: start + pos, ...parseWire(view, pos) };
    }
  } finally { await fh.close(); }
  throw new Error(`no Electron fuse sentinel found in ${exePath} (not an Electron >= 12 binary?)`);
}

/** Throw a clear error if any fuse that would block the modded copy is not OFF. */
export function assertModdable(wire, exeLabel = 'Voyager.exe') {
  if (wire.version !== 1) throw new Error(`${exeLabel}: unsupported fuse wire version ${wire.version} (expected 1); re-check fuses before modding`);
  const bad = MUST_BE_OFF.filter((n) => wire.fuses[n] !== 'off' && wire.fuses[n] !== 'removed');
  if (bad.length) {
    throw new Error(`${exeLabel}: fuse(s) ${bad.map((n) => `${n}=${wire.fuses[n] ?? 'missing'}`).join(', ')} must be OFF for a modified app.asar to load. ` +
      'Voyager has changed its hardening; this stage does not flip fuses, so the modded copy cannot be built as-is.');
  }
  return true;
}
