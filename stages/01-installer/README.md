# 01-installer

Unpack the VY.exe installer (electron-builder NSIS-3 Unicode) with 7-Zip.

## Inputs
`--input <path to VY.exe>` (or env `VRE_INPUT`). No previous stage. Needs 7-Zip: `7z`, `7za` or `7zz` on PATH, or `VRE_7Z=<path>`.

## What it does
1. Checks the input is a PE file with an NSIS `NullsoftInst` signature (in VY.exe: 152,072 bytes in, right after the 152,064-byte stub).
2. `7z x VY.exe` into `nsis/`: NSIS plugins (`System.dll`, `nsis7z.dll`, `StdUtils.dll`, ...), `$PLUGINSDIR/app-64.7z` (the app, stored uncompressed in the installer) and `$R0/Uninstall Voyager.exe`.
3. `7z x app-64.7z` into `app/`: the installed Electron app (`Voyager.exe`, `resources/app.asar`, `resources/server.asar`, `*.asar.unpacked`, bundled engines/tools).
4. Writes `files.json` (path, size, sha256 of every extracted file).

## Outputs
`out/01-installer/{nsis,app,files.json}`. The manifest lists `files.json`, the top-level app `.exe` files and `resources/*.asar|yml|json`, with hashes. Notes record installer type, payload name, 7-Zip version, file count and `app-update.yml` (update feed).

## Limits
- Needs external 7-Zip (version recorded in notes).
- Only electron-builder NSIS installers (`$PLUGINSDIR/app-<arch>.7z`); prefers `app-64.7z` when several are present.
- The NSIS install script (registry, shortcuts) is not decompiled; only the payload is extracted.

Boundary: this stage does not import other stages or `cli/`.
