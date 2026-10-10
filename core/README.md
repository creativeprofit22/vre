# core

Shared helpers. Depended on by the CLI and stages; depends on nothing in the repo.

- `manifest.mjs`: `readManifest(outDir)`, `addEntry(outDir, entry)`, `hashFile(path)`.
- `stage.mjs`: stage contract + `assertStage`.

## Inputs
An output root directory (default `out/`).

## Outputs
`<out>/manifest.json`, written atomically (tmp file + rename). Entry fields: `stage`, `status` (`ok` | `stub` | `failed`), `inputs`, `outputs`, `sha256` (path -> hash), `tool`, `limits`, `notes`, `time`. One entry per stage; re-running replaces it. Stages return `outputs` as paths relative to their own `outDir`; the CLI hashes them from there.

## Limits
No file locking: run one pipeline per output directory at a time.
