# 06-mod

Builds a **separate, modded copy** of Voyager that runs side by side with the real one. The installed app is only read.

## Inputs
- Source app folder, first match wins: `VRE_VOYAGER_DIR`, then `%LOCALAPPDATA%\Programs\voyager` (the per-user install), then `out/01-installer/app`.
- `mods/` at the repo root (or `VRE_MODS_DIR`): `patches.json`, `main/*.cjs`, `node/*.cjs`, `helpers/*.cjs`, `renderer/*.js|css`. See `mods/README.md`.

## Steps
1. **Fuses:** reads the Electron fuse wire from the source `Voyager.exe` and fails with a clear message unless `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` are OFF. Nothing is flipped. The copy's exe is re-checked after copying.
2. **Patches:** applies `patches.json` (find string/regex -> replace) in memory, to `app.asar` or `server.asar`. `file` may be a glob (`main-*.js`), because Vite/rolldown file names change with every Voyager build; `expect` then counts matches across all matched files. Each patch declares `expect`, the number of matches it must hit. If any count is off, the build fails before anything is copied and lists every broken patch.
3. **Copy:** copies the app folder to `out/06-mod/Voyager/`, wiping any previous copy first (this is also what restore does). `Uninstall Voyager.exe` is skipped, because running it would uninstall the real app.
4. **Repack:** writes a new `app.asar` (and `server.asar` if patched). It reuses the original header, so unpacked files, links and executable bits stay as they were. Patched files get fresh integrity hashes, and the archive gets `vre-loader.cjs` plus a `package.json` whose `main` points at the loader. Untouched files are copied byte for byte.
5. **Verify:** reads every repacked archive back and checks the loader is `main` and the patched content is correct.
6. **Helper hook:** writes `resources/vre-helper-hook.cjs` (from `helper-hook.cjs`) next to the archives, where Voyager's Node children can `--require` it.

## The loader (`loader.cjs`, runs before Voyager's own main)
- **Isolation:** sets `VOYAGER_HOME=out/06-mod/home`. That gives the copy its own data home, so it also gets its own Electron `userData` (`home/voyager/userdata/electron`) and its own single-instance lock, which Electron keys on `userData`. It also sets `VOYAGER_DISABLE_AUTO_UPDATE=true` and its own taskbar ID (`design.moda.voyager.vre-mod`), and blocks the copy from claiming the `voyager://` link handler.
- **Main mods:** `require`s each file in `mods/main/` and calls its exported function with `{ app, electron, log, home, config }`.
- **Helper hook:** wraps `node:child_process` (`spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync`, `fork`). Each launch goes through `mods/helpers/*.cjs` first, as `fn(call, ctx)` where `call = { api, file, args, options, helper, proc }`. A mod can log the launch, rewrite `args`, `options.env` or `options.stdio`, or swap `file` for a replacement binary. When Voyager starts one of its own Node children (`Voyager.exe` with `ELECTRON_RUN_AS_NODE=1`: the backend server and the media service), the hook adds `NODE_OPTIONS=--require <hook>`. That way launches made inside those processes (`api-models`, `voyager-resource-monitor`, `ffmpeg`, the agent CLIs, ...) are hooked too. The child strips the preload again, so unrelated grandchildren don't inherit it.
- **Node mods:** `mods/node/*.cjs` run in the main process and in every hooked Node child, before Voyager's code, as `fn({ log, home, proc, installDir })`. Use them for process-wide changes.
- **Renderer mods:** at `dom-ready` in every top-level window, runs each `mods/renderer/*.js` in the page and inserts each `*.css`. `mods/renderer/` is watched: a CSS change is swapped in place, and a JS change reloads the windows. No rebuild or restart is needed. `VRE_NO_HOT_RELOAD=1` turns this off.
- Logs to `out/06-mod/home/vre-mods.log`. A failing mod is logged and skipped, and Voyager still starts.

Default patches: `disable-auto-update` makes `getAutoUpdateDisabledReason` always return a reason, which keeps the updater off even without the environment variable. The `no-auth-*` patches (server.asar) skip the first-run setup wizard (with its account step) and remove the sidebar sign-in and avatar. Together with `mods/main/no-auth.cjs`, `mods/node/no-auth-account.cjs`, `mods/helpers/no-auth-browser.cjs` and `mods/renderer/no-auth-ui.js`, the copy runs with no sign-in at all.

## Outputs
- `Voyager/`: the runnable modded copy (`resources/vre-mod.json` holds the loader config)
- `home/`: the copy's data (login, settings, projects), kept across rebuilds
- `build.json`: source, version, fuses before and after, patch match counts and repack stats

## Commands
- `node cli/vre.mjs mod rebuild` (alias `restore`, or `npm run mod`): recreate the copy from the installed app
- `node cli/vre.mjs mod launch` (or `npm run mod:launch`): start the copy, detached

## Limits
- Only JavaScript is patched (asar archives at build time; any Node process at runtime through node mods). Native binaries (Voyager.exe, the Rust helpers, `.node` addons) are copied unchanged. Their launches can be hooked, but not their internals.
- `patches.json` targets `app.asar` and `server.asar`. Loose JS under `resources/voyager/` (the media service) is reached with node mods, not patches.
- Main, node and helper mods load once per launch. Only renderer mods hot-reload.
- Remote services (Moda cloud models, billing, provider accounts) can't be changed locally. With sign-in removed, AI features need your own API keys or a local model server.
- After a Voyager update, run `mod rebuild`. Patches whose match count changed fail loudly and must be updated.
