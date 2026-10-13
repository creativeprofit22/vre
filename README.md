# vre

Lean, modular reverse-engineering pipeline for `VY.exe`, the Windows installer of the Voyager desktop app (uni assignment).
Zero dependencies, Node >= 20. Stage 01 needs 7-Zip on PATH (or `VRE_7Z`).

Stages run in order; each reads the previous stage's output folder and records an entry in `out/manifest.json`.

| Stage | Purpose |
|---|---|
| `01-installer` | Unpack the NSIS installer and its `app-64.7z` payload |
| `02-asar` | Extract `app.asar` and `server.asar` (with `.asar.unpacked`), verifying integrity hashes |
| `03-js` | Recover original modules from bundle regions, beautify/deobfuscate minified JS, map the app, write `REPORT.md` |
| `04-native` | Analyse the native binaries (headers, imports, signatures, version info, PDB paths, strings, capabilities) |

```
node cli/vre.mjs run --input path/to/VY.exe   # run all stages (or set VRE_INPUT and use npm start)
node cli/vre.mjs stage 02-asar                # run one stage
npm run lint && npm test
```

The reports are `out/03-js/REPORT.md` (JavaScript, Electron, network) and `out/04-native/REPORT.md` (native binaries). See `docs/README.md` for the architecture and each stage's README for its inputs, outputs and limits.
