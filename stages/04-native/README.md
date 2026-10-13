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

Embedded payloads (`lib/embedded.mjs`):
- Bun standalone executables (`bun build --compile`): the module graph in the `.bun` section (or overlay) is parsed from its trailer (`---- Bun! ----`, 32-byte offsets struct, fixed-size module records) and every embedded file is written to `out/04-native/embedded/<binary>-<sha8>/` (entry point, baked-in exec argv and user agent are recorded).
- Readable copies (`lib/beautify.mjs`, zero-dep): every extracted `.js` is re-indented into `embedded/<app>/pretty/<same path>` by a string/regex/template/comment-aware tokenizer (newline after `;` `{` `}` outside `(...)`, indent by brace depth; only whitespace is inserted, checked by comparing non-whitespace content). On anything it cannot balance the original is copied as-is and the reason recorded. `pretty/index.json` and `pretty/INDEX.md` list every module with size, line counts (original -> pretty) and a short guess of what it is (`//#region` paths, `node_modules` package path, source path, imported specifiers, URLs, named classes/functions). The stage notes give the re-indented/fallback counts.
- Rust build provenance from panic/debug strings: crates.io dependencies with versions, git dependencies, first-party workspace crates and their source files, CI checkout repo, rustc commit.

## Outputs
`out/04-native/index.json` (one record per unique binary, with `bun` and `rust` fields where found), `REPORT.md` (overview, first-party binaries in detail, embedded payloads, bundled tools table, limits) and `embedded/` (files extracted from Bun standalone apps; not listed in the manifest).

## Limits
- Static only: no disassembly, decompilation or execution.
- Signatures are detected, not cryptographically verified (Windows' `Get-AuthenticodeSignature` agrees on the samples checked by hand).
- `Voyager.exe` is the Electron/Chromium host, so its imports and strings describe Chromium; Voyager's own logic is in the JavaScript (stage 03-js).
- Capabilities come from import tables; APIs resolved at runtime (`GetProcAddress`, napi-rs modules) are invisible.
- Strings are capped per category and file.
- Bun graphs are parsed from the Bun 1.1-1.3 layout; extracted JS is as shipped (minified; `pretty/` only re-indents it, identifiers stay mangled, regex-vs-division after `)`/`}` is a heuristic), and bytecode is not decompiled.
- Rust provenance lists what was compiled in (paths left in strings), not what runs; code without panic paths is invisible.

Boundary: this stage does not import other stages or `cli/`.
