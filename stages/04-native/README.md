# 04-native

Static analysis of every native binary shipped with Voyager: the Electron host, Voyager's own helper programs, Node native modules (`.node`), bundled tools/engines and installer plug-ins. Pure Node (`lib/pe.mjs`), no disassembler.

## Inputs
The output folders of `01-installer` (`out/01-installer/{app,nsis}`) and `02-asar` (`out/02-asar/`), found as siblings of this stage's output folder (it reads them, it never imports those stages). Fails if `out/01-installer/app` is missing.

## What it does
For every PE file (`MZ` + `PE\0\0`), deduplicated by SHA-256 (identical copies are listed under `copies`):
- headers: machine, PE32/PE32+, subsystem, link time, hardening flags (ASLR, DEP, CFG, high-entropy VA)
- sections with Shannon entropy (executable sections above 7.2 bits/byte are flagged as possibly packed)
- imports (incl. delay-load) and exports; capabilities inferred from imported APIs (network, process control, elevation, registry, crypto, audio, screen capture, input hooks, named pipes, ...)
- version resource (ProductName, FileVersion, ...), PDB path from the CodeView debug record, Rich header, .NET header, overlay
- Authenticode: presence and certificate subject names (signer guessed as the first non-CA name)
- interesting strings (ASCII and UTF-16LE): URLs, named pipes, registry keys, paths, env vars, shell commands, toolchain markers (Rust/Go/PyInstaller/...)
Also summarises `resources/engines/engines-manifest.json` and the tools under `resources/voyager/native/`.

## Outputs
`out/04-native/index.json` (one record per unique binary) and `REPORT.md` (overview, first-party binaries in detail, bundled tools table, limits).

## Limits
- Static only: no disassembly, decompilation or execution.
- Signatures are detected, not cryptographically verified (Windows' `Get-AuthenticodeSignature` agrees on the samples checked by hand).
- `Voyager.exe` is the Electron/Chromium host, so its imports and strings describe Chromium; Voyager's own logic is in the JavaScript (stage 03-js).
- Capabilities come from import tables; APIs resolved at runtime (`GetProcAddress`, napi-rs modules) are invisible.
- Strings are capped per category and file.

Boundary: this stage does not import other stages or `cli/`.
