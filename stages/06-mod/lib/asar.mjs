// Minimal asar read + repack (pure Node). Layout as in electron/asar src/disk.ts:
//   [uint32 4][uint32 headerBufLen] then headerBuf = [uint32 payloadLen][uint32 jsonLen][json][pad to 4], then file data.
// Repacking reuses the original header tree (order, unpacked flags, executable bits, links) and only
// swaps the bytes of replaced files and appends added files, so everything else stays byte-identical.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const BLOCK = 4 * 1024 * 1024;

export async function openArchive(path) {
  const fh = await open(path, 'r');
  try {
    const pre = Buffer.alloc(16);
    const { bytesRead } = await fh.read(pre, 0, 16, 0);
    if (bytesRead < 16 || pre.readUInt32LE(0) !== 4) throw new Error(`${path}: not an asar archive`);
    const headerLen = pre.readUInt32LE(4);
    const jsonLen = pre.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > headerLen) throw new Error(`${path}: bad asar header length`);
    const json = Buffer.alloc(jsonLen);
    await fh.read(json, 0, jsonLen, 16);
    return { fh, header: JSON.parse(json.toString('utf8')), dataOffset: 8 + headerLen };
  } catch (err) { await fh.close(); throw err; }
}

function segments(p) {
  const s = p.split('/');
  if (s.some((x) => !x || x === '.' || x === '..')) throw new Error(`bad asar path: ${p}`);
  return s;
}

/** Find a node by "a/b/c" path; null if missing. */
export function findNode(header, p) {
  let node = header;
  for (const s of segments(p)) { node = node.files?.[s]; if (!node) return null; }
  return node;
}

export async function readFile(arch, p) {
  const node = findNode(arch.header, p);
  if (!node || node.files || 'link' in node) return null;
  if (node.unpacked) throw new Error(`${p} lives in .asar.unpacked; patch it on disk instead`);
  const buf = Buffer.alloc(Number(node.size));
  if (buf.length) await arch.fh.read(buf, 0, buf.length, arch.dataOffset + Number(node.offset));
  return buf;
}

export function integrityOf(buf) {
  const blocks = [];
  for (let o = 0; o < buf.length; o += BLOCK) blocks.push(createHash('sha256').update(buf.subarray(o, o + BLOCK)).digest('hex'));
  if (!buf.length) blocks.push(createHash('sha256').update(buf).digest('hex'));
  return { algorithm: 'SHA256', hash: createHash('sha256').update(buf).digest('hex'), blockSize: BLOCK, blocks };
}

export function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = (json.length + 3) & ~3;
  const headerBuf = Buffer.alloc(8 + padded);
  headerBuf.writeUInt32LE(4 + padded, 0);
  headerBuf.writeUInt32LE(json.length, 4);
  json.copy(headerBuf, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(headerBuf.length, 4);
  return Buffer.concat([size, headerBuf]);
}

/**
 * Write a new archive at dest from source archive `arch`.
 * changes: Map<"a/b.js", Buffer> replacing existing packed files or adding new ones.
 */
export async function repack(arch, dest, changes) {
  const header = structuredClone(arch.header);
  for (const [p, buf] of changes) {
    const segs = segments(p);
    let node = header;
    for (const s of segs.slice(0, -1)) {
      node.files ??= {};
      node = node.files[s] ??= { files: {} };
      if (!node.files) throw new Error(`cannot add ${p}: ${s} is a file`);
    }
    const name = segs.at(-1);
    const prev = node.files[name];
    if (prev?.files || (prev && 'link' in prev)) throw new Error(`cannot replace ${p}: not a regular file`);
    if (prev?.unpacked) throw new Error(`cannot replace ${p}: it lives in .asar.unpacked`);
    node.files[name] = { size: buf.length, ...(prev?.executable ? { executable: true } : {}), integrity: integrityOf(buf) };
  }
  // Assign offsets in header walk order; remember where each file's bytes come from.
  const plan = [];
  let offset = 0;
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) { walk(child, p); continue; }
      if ('link' in child || child.unpacked) continue;
      const changed = changes.get(p);
      const srcOffset = changed ? null : arch.dataOffset + Number(findNode(arch.header, p).offset);
      plan.push({ size: Number(child.size), changed, srcOffset });
      child.offset = String(offset);
      offset += Number(child.size);
    }
  })(header, '');
  const out = await open(dest, 'w');
  try {
    const head = encodeHeader(header);
    await out.write(head, 0, head.length, 0);
    let pos = head.length;
    const tmp = Buffer.allocUnsafe(BLOCK);
    for (const f of plan) {
      if (f.changed) { await out.write(f.changed, 0, f.changed.length, pos); pos += f.changed.length; continue; }
      for (let done = 0; done < f.size;) {
        const n = Math.min(BLOCK, f.size - done);
        const { bytesRead } = await arch.fh.read(tmp, 0, n, f.srcOffset + done);
        if (bytesRead !== n) throw new Error('short read while repacking');
        await out.write(tmp, 0, n, pos);
        pos += n; done += n;
      }
    }
    return { files: plan.length, bytes: pos };
  } finally { await out.close(); }
}
