// Shared stage-boundary check, used by scripts/lint.mjs and test/pipeline.test.mjs.
import { dirname, relative, resolve, sep } from 'node:path';

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

/**
 * @param {string} root repo root (absolute)
 * @param {string} file absolute path of the file being checked
 * @param {string} source file contents
 * @returns {string[]} violation messages
 */
export function boundaryViolations(root, file, source) {
  const rel = relative(root, file).split(sep).join('/');
  const parts = rel.split('/');
  const area = parts[0];
  if (area !== 'stages' && area !== 'core') return [];
  const out = [];
  for (const [, spec] of source.matchAll(IMPORT_RE)) {
    if (!spec.startsWith('.')) continue;
    const target = relative(root, resolve(dirname(file), spec)).split(sep).join('/');
    const t = target.split('/');
    let bad = false;
    if (t[0] === '..') bad = true;
    else if (t[0] === 'cli') bad = true;
    else if (area === 'stages' && t[0] === 'stages' && t[1] !== parts[1]) bad = true;
    else if (area === 'core' && t[0] !== 'core') bad = true;
    if (bad) out.push(`${rel}: forbidden import "${spec}"`);
  }
  return out;
}
