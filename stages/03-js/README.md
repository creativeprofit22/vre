# 03-js

Analyse the JavaScript extracted by stage 02: split rolldown bundles back into their original modules, beautify minified chunks, decode embedded blobs, and build an app-level map and report.

## Inputs
`out/02-asar/`: one folder per asar archive (`app/`, `server/`, ...) with unpacked files merged in. `index.json` there is optional. The stage fails with a clear error if the folder is missing or holds no archive folders.

## Outputs (`out/03-js/`)
- `recovered/<archive>/<bundle path>/<module path>`: each `//#region <path>` block as its own file. Paths are normalized (leading `../` stripped, `\0` → `_virtual/`, Windows-invalid characters replaced, escaping paths rejected). Code outside regions goes to `_unregioned.js`. **Files keep the original extension (`.ts`, `.tsx`, ...) but contain the compiled JS rolldown emitted, not the original source.**
- `beautified/<archive>/<path>`: minified first-party JS (average line > 300 chars) passed through `beautify(deobfuscate(src).code)`.
- `embedded/<file>.<n>.<ext>`: base64 blobs (wasm, png, ...) reported by `deobfuscate`.
- `index.json`: per first-party JS file: archive, path, size, sha256, kind (`node-bundle|browser-chunk|preload|other`), minified, region count, imports, deobfuscation changes/signals. Plus per-archive counts.
- `map.json`: packages (name@version from pnpm region paths and `node_modules/*/package.json`), first-party modules by group, Electron surface (IPC channels with const-resolved names, `exposeInMainWorld`, webPreferences flags, protocols, `shell.openExternal`), URLs by host, `process.env` names, Sentry debugIds, sourceMappingURL refs, and `surface`: HTTP routes served (router registrations, MCP/HTTP layers, request-URL checks) and called (request objects, generated API clients, socket requests, `/v1/...` paths), RPC method tables (`const *_METHODS = {...}` with spreads expanded) and JSON-RPC `method: "a/b"` literals, `contextBridge` members flattened to dotted paths with the IPC channels each one reaches, IPC sender checks (`senderFrame` comparisons/URL reads, `ensure*Sender` helpers), and shipped `.node` addons linked to their loader package and the first-party bundles importing it.
- `REPORT.md`: readable report built from the above.

The manifest lists only `index.json`, `map.json`, `REPORT.md` and `embedded/*`; counts of recovered/beautified files are in the notes.

Code: `index.mjs` (orchestration), `lib/regions.mjs` (splitting, paths, imports, classification), `lib/map.mjs` (scans and map), `lib/surface.mjs` (routes, RPC tables, bridge members, sender checks, addon loads), `lib/report.mjs`. Transforms (`lib/beautify.mjs`, `lib/deobfuscate.mjs`) are loaded lazily; if missing, that step is skipped and a limit says so.

## Limits
- Recovered modules are compiled JS, not original TypeScript; source maps are not shipped.
- All scans (imports, IPC, URLs, env, flags, routes, RPC tables, bridge members) are regex/brace-matching based: dynamic or computed values stay unresolved, and some matches may come from strings.
- Outbound API calls include bundled third-party clients and do not show which calls actually run; sender checks are observations, not proof of complete authorization.
- `node_modules/` inside the archives is counted and its `package.json` read, but not indexed, recovered or beautified.
- Deobfuscation is best-effort and never proves original source.

Boundary: this stage only reads the previous stage's output folder and the manifest. It must not import other stages or `cli/`.
