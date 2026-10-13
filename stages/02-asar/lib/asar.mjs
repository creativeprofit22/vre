// Minimal, dependency-free reader for Electron asar archives.
// Layout: [uint32 4][uint32 headerPickleSize][uint32 headerPayloadSize][uint32 jsonLen][json...] then file data at 8 + headerPickleSize.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/** Parse the header of an open asar file handle. */
export async function readHeader(fh) {
  const pre = Buffer.alloc(16);
  const { bytesRead } = await fh.read(pre, 0, 16, 0);
  if (bytesRead < 16 || pre.readUInt32LE(0) !== 4) throw new Error('not an asar archive (bad pickle prefix)');
  const pickleSize = pre.readUInt32LE(4);
  const jsonLen = pre.readUInt32LE(12);
  if (jsonLen <= 0 || jsonLen > pickleSize) throw new Error('not an asar archive (bad header length)');
  const json = Buffer.alloc(jsonLen);
  await fh.read(json, 0, jsonLen, 16);
  return { header: JSON.parse(json.toString('utf8')), dataOffset: 8 + pickleSize };
}

/** Reject names that could escape the extraction folder. */
export function safeSegment(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error(`unsafe asar entry name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Flatten the header tree into entries { path, type: 'file'|'dir'|'link', ...node }. */
export function listEntries(header) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${safeSegment(name)}` : safeSegment(name);
      if (child.files) { out.push({ path, type: 'dir' }); walk(child, path); }
      else if ('link' in child) out.push({ path, type: 'link', link: child.link });
      else out.push({ path, type: 'file', size: Number(child.size), offset: child.offset, unpacked: !!child.unpacked, executable: !!child.executable, integrity: child.integrity ?? null });
    }
  })(header, '');
  return out;
}

/** Read a packed file's bytes. */
export async function readPacked(fh, dataOffset, entry) {
  const buf = Buffer.alloc(entry.size);
  if (entry.size > 0) await fh.read(buf, 0, entry.size, dataOffset + Number(entry.offset));
  return buf;
}

/** Check a buffer against an asar integrity record ({ algorithm, hash, blockSize, blocks }). */
export function checkIntegrity(buf, integrity) {
  if (!integrity) return null;
  if (String(integrity.algorithm).toUpperCase() !== 'SHA256') return null;
  if (createHash('sha256').update(buf).digest('hex') !== integrity.hash) return false;
  if (Array.isArray(integrity.blocks) && integrity.blockSize > 0) {
    for (let i = 0, o = 0; o < buf.length || i === 0; i++, o += integrity.blockSize) {
      const block = buf.subarray(o, o + integrity.blockSize);
      if (createHash('sha256').update(block).digest('hex') !== integrity.blocks[i]) return false;
      if (o + integrity.blockSize >= buf.length) break;
    }
  }
  return true;
}

export async function openAsar(path) {
  const fh = await open(path, 'r');
  try {
    const { header, dataOffset } = await readHeader(fh);
    return { fh, header, dataOffset, entries: listEntries(header) };
  } catch (err) { await fh.close(); throw err; }
}
