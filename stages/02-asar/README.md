# 02-asar

Extract every Electron `.asar` archive found by stage 01. Pure Node (`lib/asar.mjs`), no `@electron/asar`.

## Inputs
`out/01-installer/`. Every `*.asar` under it is extracted (Voyager has `app.asar`, the Electron main process and preloads, and `server.asar`, the local server and web client).

## What it does
- Parses the asar pickle header and writes each file. Entries marked `unpacked` are copied from the sibling `<name>.asar.unpacked/`, so each output folder is the complete tree the app sees at runtime.
- Verifies every packed file against its SHA-256 `integrity` record (whole file plus blocks).
- Rejects entry names that could escape the output folder (`..`, separators, NUL).

## Outputs
`out/02-asar/<archive name>/...` (e.g. `app/`, `server/`) and `index.json`:
`{ archives: [{ name, source, files, bytes, unpacked, links, integrity: { ok, failed[], missing }, missingUnpacked[] }] }`.
Status is `failed` if any integrity check fails or an unpacked file is missing.

## Limits
- Symlink entries are listed in `index.json`, not created.
- Native modules and executables are copied, not analysed.
- The asar header hash pinned inside the Electron binary is not checked, only the per-file hashes.
- Files are read whole into memory one at a time (the largest packed file in Voyager is about 10 MB).

Boundary: this stage does not import other stages or `cli/`.
