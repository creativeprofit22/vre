# Architecture

```
VY.exe -> [01-installer] -> out/01-installer/ -> [02-asar] -> out/02-asar/ -> [03-js] -> out/03-js/ -> [04-native] -> out/04-native/ -> [05-report] -> out/05-report/
                 \_______________________ out/manifest.json (one entry per stage) _______________________/
```
`04-native` analyses binaries from `out/01-installer/` and `out/02-asar/`, which it reads as sibling output folders (not via imports). `05-report` reads the outputs of 01-04 the same way and writes the summary.

## Rules
- Stages communicate only through output folders and manifest entries.
- A stage reads `out/<previous stage>/` and the manifest; it never imports another stage or `cli/`.
- Only `cli/registry.mjs` knows the stage order. `core/` imports nothing from the repo.
- Stages must be honest: unimplemented work reports `status: "stub"`, never `ok`.
- `npm run lint` and `npm test` enforce the import boundary.

## Manifest (`out/manifest.json`)
```json
{ "version": 1, "entries": [{
  "stage": "02-asar",
  "status": "ok | stub | failed",
  "inputs": ["path"],
  "outputs": ["relative path inside the stage folder"],
  "sha256": { "relative path": "hex" },
  "tool": "name/version",
  "limits": ["known limitation"],
  "notes": ["free text"],
  "time": "ISO-8601"
}]}
```
Re-running a stage replaces its entry.

## Running
- `npm start` or `node cli/vre.mjs run [--input VY.exe] [--out out]`: all stages in order. `--input` falls back to env `VRE_INPUT`.
- Stage 01 needs an external 7-Zip binary (`7z`/`7za`/`7zz` on PATH, or `VRE_7Z`). Everything else is pure Node.
- `node cli/vre.mjs stage <name>`: one stage; it expects the previous stage's folder to exist if it needs it.

## Add a stage
1. Create `stages/NN-name/index.mjs` (default export per `core/stage.mjs`) and a `README.md` (inputs, outputs, limits).
2. Add the name to `STAGES` in `cli/registry.mjs`.
3. Run `npm run lint && npm test`.
