// Source patches: find (string or regex) -> replacement, each with an expected match count.
// Every patch is checked before anything is written; any mismatch fails the whole build.

/**
 * Validate a patch list (parsed patches.json).
 * Patch: { id, file, archive?: 'app'|'server', find, regex?: boolean, flags?: string, replace, expect: integer >= 0 }
 */
export function validatePatches(patches) {
  if (!Array.isArray(patches)) throw new Error('patches.json must be a JSON array');
  const ids = new Set();
  for (const [i, p] of patches.entries()) {
    const where = `patch #${i}${p?.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') throw new Error(`${where}: must be an object`);
    if (typeof p.id !== 'string' || !p.id) throw new Error(`${where}: needs a string "id"`);
    if (ids.has(p.id)) throw new Error(`${where}: duplicate id`);
    ids.add(p.id);
    if (typeof p.file !== 'string' || !p.file || p.file.startsWith('/') || p.file.split('/').includes('..')) throw new Error(`${where}: "file" must be a relative path inside the archive`);
    if (p.archive !== undefined && p.archive !== 'app' && p.archive !== 'server') throw new Error(`${where}: "archive" must be "app" or "server"`);
    if (typeof p.find !== 'string' || !p.find) throw new Error(`${where}: needs a non-empty string "find"`);
    if (typeof p.replace !== 'string') throw new Error(`${where}: needs a string "replace"`);
    if (!Number.isInteger(p.expect) || p.expect < 0) throw new Error(`${where}: needs an integer "expect" >= 0 (how many matches the patch must hit)`);
    if (p.regex) new RegExp(p.find, flagsOf(p)); // throws on a bad pattern
  }
  return patches;
}

function flagsOf(p) {
  const f = p.flags ?? '';
  return f.includes('g') ? f : `${f}g`;
}

/** Count and apply one patch to a string. Returns { text, count }. */
export function applyOne(text, p) {
  if (p.regex) {
    const re = new RegExp(p.find, flagsOf(p));
    const count = [...text.matchAll(re)].length;
    return { text: count ? text.replace(re, p.replace) : text, count };
  }
  const parts = text.split(p.find);
  return { text: parts.join(p.replace), count: parts.length - 1 };
}

/** True when a patch "file" is a glob (`*` matches within one path segment, `**` across segments). */
export const isGlob = (file) => file.includes('*');

/** Compile a patch file glob to a RegExp over archive paths. */
export function globToRegExp(glob) {
  const src = glob.split(/(\*\*|\*)/).map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${src}$`);
}

/** The archive paths a patch targets: its file, or every listed path its glob matches. */
export function targetsOf(p, list) {
  if (!isGlob(p.file)) return [p.file];
  const re = globToRegExp(p.file);
  return (list ? list(p.archive ?? 'app') : []).filter((f) => re.test(f)).sort();
}

/**
 * Apply patches to in-memory sources.
 * read(archive, file) -> string | null (null when the file is missing).
 * list(archive) -> string[] of every file path in the archive (only needed for glob "file"s).
 * A glob patch's "expect" is the total match count across every file it matches, so a build whose
 * hashed file names changed still patches the same code, and a changed count still fails loudly.
 * Returns { files: Map<"archive:file", string>, results: [{ id, archive, file, expect, count, matched? }] }.
 * Throws one error listing every mismatch, so a Voyager update can't break patches silently.
 */
export function applyPatches(patches, read, list) {
  validatePatches(patches);
  const files = new Map();
  const results = [];
  const problems = [];
  for (const p of patches) {
    const archive = p.archive ?? 'app';
    const targets = targetsOf(p, list);
    if (isGlob(p.file) && targets.length === 0) { problems.push(`${p.id}: no file matches ${archive}.asar/${p.file}`); continue; }
    const next = new Map();
    let count = 0;
    let missing = false;
    for (const file of targets) {
      const key = `${archive}:${file}`;
      const src = files.has(key) ? files.get(key) : read(archive, file);
      if (src === null || src === undefined) { problems.push(`${p.id}: file not found: ${archive}.asar/${file}`); missing = true; break; }
      const r = applyOne(src, p);
      count += r.count;
      next.set(key, { src, text: r.text, count: r.count });
    }
    if (missing) continue;
    const matched = [...next].filter(([, v]) => v.count > 0).map(([k]) => k.slice(archive.length + 1));
    results.push({ id: p.id, archive, file: p.file, expect: p.expect, count, ...(isGlob(p.file) ? { matched } : {}) });
    if (count !== p.expect) {
      problems.push(`${p.id}: expected ${p.expect} match(es) in ${archive}.asar/${p.file}, found ${count}`);
      for (const [key, v] of next) if (!files.has(key)) files.set(key, v.src);
    } else {
      for (const [key, v] of next) if (v.count > 0 || files.has(key)) files.set(key, v.text);
    }
  }
  if (problems.length) {
    const err = new Error(`patch check failed (${problems.length}):\n  - ${problems.join('\n  - ')}\nUpdate mods/patches.json for this Voyager version.`);
    err.results = results;
    throw err;
  }
  return { files, results };
}
