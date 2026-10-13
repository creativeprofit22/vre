# mods

Your changes to the modded Voyager copy (stage `06-mod`). The installed Voyager is never touched.

| Path | What it is | When it applies |
|---|---|---|
| `main/*.js`, `main/*.cjs` | CommonJS run in Voyager's main process before Voyager starts. Export a function; it gets `{ app, electron, log, home, config }`. | Next launch (no rebuild) |
| `node/*.cjs` | CommonJS run first in the main process and in every Voyager Node process (backend server, media service). Export a function; it gets `{ log, home, proc, installDir }`. | Next launch (no rebuild) |
| `helpers/*.cjs` | Called before every process launch (`child_process` spawn/exec/fork) in those processes, including the Rust helpers. Export `function (call, ctx)`: change `call.file`, `call.args` or `call.options` (env, stdio, cwd) to rewrite the launch or swap in a replacement binary. | Next launch (no rebuild) |
| `renderer/*.js` | Browser scripts run in every Voyager window at `dom-ready` (main world). | **Live**: saving one reloads the windows |
| `renderer/*.css` | Stylesheets inserted into every Voyager window. | **Live**: swapped in place, no reload |
| `patches.json` | Source patches baked into the copy's `app.asar` / `server.asar`. | `node cli/vre.mjs mod rebuild` |

Files starting with `_` are ignored. Mods load in file-name order. Errors are caught and logged, and Voyager still starts.

## patches.json

```json
[{ "id": "my-patch", "file": "apps/desktop/dist-electron/main.cjs", "archive": "app",
   "find": "text or regex", "regex": false, "flags": "", "replace": "new text", "expect": 1 }]
```
- `file`: a path inside the archive (browse `out/02-asar/app` or `out/02-asar/server`). `archive` defaults to `app`.
- `expect`: how many matches the patch must hit. Any mismatch fails the whole build and lists every broken patch, so a Voyager update can't silently break a patch.
- With `regex: true`, `find` is a JS regex (always global) and `replace` may use `$1` and similar groups.

`file` may be a glob such as `apps/server/dist/client/assets/main-*.js`, because Voyager's bundle file names change with every build. `expect` then counts matches across all matched files.

The default patches turn off auto-update and remove sign-in (see below).

## What ships here

| File | Does |
|---|---|
| `patches.json` `disable-auto-update` | The copy never updates itself. |
| `patches.json` `no-auth-*` (server.asar) | Skip the first-run setup and its account step, and remove the sidebar sign-in and avatar. |
| `main/no-auth.cjs` | Blocks every sign-in page (OAuth/OpenID: OpenAI, Google, GitHub, Microsoft, Clerk, ...) from opening in the browser. |
| `node/no-auth-account.cjs` | The saved Voyager account reads as signed out in every process. The file on disk is not touched. |
| `helpers/no-auth-browser.cjs` | Same block for browser launches made by child processes. |
| `renderer/no-auth-ui.js` | Hides any remaining Sign in / Iniciar sesión controls. API-key fields stay. |
| `helpers/isolate-api-models.cjs` | Gives the bundled api-models (OpenCode) its own data folders inside the copy's home, instead of the shared `~/.local/share/opencode`. |
| `helpers/log-launches.cjs` | Sample: logs every process launch, with the helper name. |
| `main/sample-hello.cjs`, `renderer/sample-badge.js`, `renderer/_sample-outline.css` | Samples (rename `_x` to `x` to enable). |

To turn a mod off, prefix its file name with `_`.

## Commands

```
node cli/vre.mjs mod rebuild   # recreate the copy from the installed Voyager (restore + repack + patches)
node cli/vre.mjs mod launch    # start the modded copy
```
The copy is in `out/06-mod/Voyager/`. Its data (login, settings, projects) lives in `out/06-mod/home/`, which is kept across rebuilds. The loader log is `out/06-mod/home/vre-mods.log`.
Overrides: `VRE_VOYAGER_DIR` (source install), `VRE_MODS_DIR` (this folder), `VRE_MOD_HOME` (data home at launch).
