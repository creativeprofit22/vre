import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { boundaryViolations } from '../scripts/boundaries.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addEntry, hashFile, readManifest } from '../core/manifest.mjs';
import { runAll, runStage } from '../cli/vre.mjs';
import { STAGES } from '../cli/registry.mjs';

const quiet = () => {};
const tmp = () => mkdtemp(join(tmpdir(), 'vre-'));

test('manifest roundtrip and replace-by-stage', async () => {
  const dir = await tmp();
  try {
    assert.deepEqual((await readManifest(dir)).entries, []);
    await addEntry(dir, { stage: 'a', status: 'ok' });
    await addEntry(dir, { stage: 'a', status: 'stub' });
    const m = await readManifest(dir);
    assert.equal(m.entries.length, 1);
    assert.equal(m.entries[0].status, 'stub');
    await assert.rejects(addEntry(dir, { stage: 'x' }));
    assert.match(await hashFile(join(dir, 'manifest.json')), /^[0-9a-f]{64}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run all executes stages in order and records each entry', async () => {
  const dir = await tmp();
  try {
    const seen = [];
    const load = async (name) => ({ default: { name, run: async ({ inDir }) => { seen.push([name, inDir && inDir.split(/[\\/]/).pop()]); return { status: 'stub' }; } } });
    await runAll({ out: dir, log: quiet, load });
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(m.entries.map((e) => e.stage), STAGES);
    assert.deepEqual(seen, STAGES.map((s, i) => [s, i ? STAGES[i - 1] : null]));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real stages fail honestly without input', async () => {
  const dir = await tmp();
  try {
    await assert.rejects(runAll({ out: dir, log: quiet }), /--input/);
    await assert.rejects(runStage('02-asar', { out: dir, log: quiet }), /01-installer/);
    const m = await readManifest(dir);
    assert.deepEqual(m.entries.map((e) => [e.stage, e.status]), [['01-installer', 'failed'], ['02-asar', 'failed']]);
    await assert.rejects(runStage('nope', { out: dir, log: quiet }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a throwing stage records a failed entry and run-all stops', async () => {
  const dir = await tmp();
  try {
    const load = async (name) => ({
      default: {
        name,
        run: async () => {
          if (name === STAGES[1]) throw new Error('boom');
          return { status: 'stub' };
        },
      },
    });
    await assert.rejects(runAll({ out: dir, log: quiet, load }), /boom/);
    const m = await readManifest(dir);
    assert.deepEqual(m.entries.map((e) => [e.stage, e.status]), [[STAGES[0], 'stub'], [STAGES[1], 'failed']]);
    assert.deepEqual(m.entries[1].notes, ['boom']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stages do not import other stages or the CLI', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const s of STAGES) {
    const dir = join(root, 'stages', s);
    for (const f of await readdir(dir, { recursive: true })) {
      if (!f.endsWith('.mjs')) continue;
      const file = join(dir, f);
      assert.deepEqual(boundaryViolations(root, file, await readFile(file, 'utf8')), []);
    }
  }
});

test('boundary check catches sibling-stage, cli and escaping imports', () => {
  const root = join(tmpdir(), 'vre-root');
  const f = join(root, 'stages', '03-js', 'index.mjs');
  assert.equal(boundaryViolations(root, f, "import x from '../02-asar/index.mjs';").length, 1);
  assert.equal(boundaryViolations(root, f, "import x from '../../cli/vre.mjs';").length, 1);
  assert.equal(boundaryViolations(root, f, "import x from '../../core/manifest.mjs';").length, 0);
  assert.equal(boundaryViolations(root, f, "import x from './util.mjs';").length, 0);
  const c = join(root, 'core', 'a.mjs');
  assert.equal(boundaryViolations(root, c, "import x from '../stages/01/i.mjs';").length, 1);
});
