# 05-report

Cross-stage summary of Voyager: one `REPORT.md` that ties the installer, archives, JavaScript and native findings together. Pure Node, no new parsing of binaries.

## Inputs
Sibling output folders (read, never imported): `out/03-js/map.json` and `out/04-native/index.json` (required), plus `out/03-js/index.json`, `out/02-asar/{app,server}/package.json`, `out/01-installer/app/resources/app-update.yml` and `out/manifest.json` when present. Fails if a required file is missing.

## What it does
- Identity: product/version, Electron and Chromium versions (host binary strings), update feed, installer type, packages.
- Architecture: evidence probes run over the Electron main bundle named by `app/package.json` `main`. Each probe is a literal/regex; a claim is printed only when its probe matches, with the file and byte offset as evidence. Unmatched probes are listed and their claims are left out.
- First-party code (workspace packages recovered from rolldown regions), interfaces between the parts (contextBridge/IPC, WebSocket RPC table, served HTTP routes, JSON-RPC, outbound hosts, native addons), native components (Bun app identity, Rust CI repo and crates), security observations (webPreferences, sender checks, runtime-built channels, Authenticode, packing, build leftovers) and the status of every stage.

## Outputs
`out/05-report/REPORT.md` and `out/05-report/probes.json` (each probe with its match location or `null`).

## Limits
- Every number comes from stages 01-04, so their limits apply.
- A probe hit shows the code exists, not that it runs on every path.

Boundary: this stage does not import other stages or `cli/`.
