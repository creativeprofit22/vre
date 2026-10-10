/**
 * Stage contract. A stage module default-exports:
 *   { name: string,
 *     run({ inDir, outDir, input, manifest, log }) -> { status: 'ok'|'stub'|'failed', inputs?: string[], outputs: string[] (paths relative to outDir), notes?: string[], limits?: string[] } }
 * inDir  = previous stage's output folder (or null for the first stage)
 * outDir = this stage's own output folder
 * Stages must not import other stages or the CLI.
 */
export function assertStage(mod, expectedName) {
  const s = mod?.default;
  if (!s || typeof s.run !== 'function' || typeof s.name !== 'string') {
    throw new Error(`stage ${expectedName} does not satisfy the stage contract`);
  }
  if (s.name !== expectedName) throw new Error(`stage name mismatch: ${s.name} != ${expectedName}`);
  return s;
}
