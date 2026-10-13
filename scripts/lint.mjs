// Zero-dependency lint: syntax check every .mjs/.cjs (and mods/**/*.js), and enforce stage boundaries on .mjs.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundaryViolations } from './boundaries.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', '.gg', 'out']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/.(mjs|cjs)$/.test(e.name) || (e.name.endsWith('.js') && relative(root, p).split(sep)[0] === 'mods')) out.push(p);
  }
  return out;
}

let failed = false;
const fail = (m) => { console.error(m); failed = true; };

for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax error in ${rel}\n${r.stderr}`);
  if (file.endsWith('.mjs')) for (const v of boundaryViolations(root, file, readFileSync(file, 'utf8'))) fail(v);
}
if (failed) process.exit(1);
console.log('lint ok');
