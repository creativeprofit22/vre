'use strict';
// vre mod loader. Injected into the modded copy's app.asar by stage 06-mod and set as package.json "main".
// Runs before Voyager's own main: isolates the copy from the real install, loads main-process mods,
// injects renderer mods into every window, then hands over to the original entry point.
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

const cfg = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'vre-mod.json'), 'utf8'));
const env = process.env;

// 1. Isolation: own data home (=> own userData and single-instance lock), no auto-update, own taskbar id.
const home = env.VRE_MOD_HOME || cfg.home;
env.VOYAGER_HOME = home;
delete env.VOYAGER_SESSION_HOME; // would override VOYAGER_HOME and could point at the real app's data
env.VOYAGER_DISABLE_AUTO_UPDATE = 'true';
env.VOYAGER_DESKTOP_APP_USER_MODEL_ID = cfg.appUserModelId;
fs.mkdirSync(home, { recursive: true });

const logFile = path.join(home, 'vre-mods.log');
function log(...args) {
  const line = `[vre ${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ')}`;
  try { fs.appendFileSync(logFile, `${line}\n`); } catch {}
  try { console.log(line); } catch {}
}
log(`loader start pid=${process.pid} home=${home} mods=${cfg.modsDir}`);

// The real Voyager owns the voyager:// scheme; the copy must not re-point it at itself.
const { app } = electron;
app.setAsDefaultProtocolClient = (scheme) => { log(`blocked protocol registration: ${scheme}://`); return false; };
app.removeAsDefaultProtocolClient = () => false;

function listMods(sub, exts) {
  const dir = path.join(env.VRE_MODS_DIR || cfg.modsDir, sub);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => exts.some((e) => n.endsWith(e)) && !n.startsWith('_')).sort().map((n) => path.join(dir, n));
}

// 2. Native helper hook: every child_process launch (main process, and Voyager's own Node children such as
//    the backend server) goes through mods/helpers/*.cjs first. See vre-helper-hook.cjs.
const modsDir = env.VRE_MODS_DIR || cfg.modsDir;
const hookFile = path.join(process.resourcesPath, 'vre-helper-hook.cjs');
let helperHook = null;
try {
  helperHook = require(hookFile).install({ log, modsDir, installDir: path.dirname(process.execPath), proc: 'main', hookFile, logFile });
  require(hookFile).loadNodeMods(modsDir, { log, home, proc: 'main', installDir: path.dirname(process.execPath) });
} catch (err) { log('helper hook FAILED to install:', err); }

// 3. Main-process mods: CommonJS files; a function export is called with ctx.
const ctx = { app, electron, log, home, config: cfg, helpers: helperHook && { onLaunch: (fn) => helperHook.handlers.push(fn) } };
for (const file of listMods('main', ['.js', '.cjs'])) {
  try {
    const mod = require(file);
    const fn = typeof mod === 'function' ? mod : typeof mod?.default === 'function' ? mod.default : null;
    if (fn) fn(ctx);
    log(`main mod loaded: ${path.basename(file)}`);
  } catch (err) { log(`main mod FAILED: ${path.basename(file)}:`, err); }
}

// 4. Renderer mods: JS run in the page's main world, CSS inserted, on every window load.
//    Files are read fresh on each load, and mods/renderer is watched: a CSS change is swapped in place,
//    a JS change reloads the windows (scripts can't be un-run). Set VRE_NO_HOT_RELOAD=1 to turn it off.
const rendererDir = path.join(modsDir, 'renderer');
const readMods = (exts) => listMods('renderer', exts).map((f) => {
  try { return { name: path.basename(f), code: fs.readFileSync(f, 'utf8') }; } catch { return null; }
}).filter(Boolean);
const windows = new Map(); // webContents -> Map(css name -> insertCSS key)

async function applyCss(wc) {
  const keys = windows.get(wc);
  if (!keys) return;
  for (const key of keys.values()) await wc.removeInsertedCSS(key).catch(() => {});
  keys.clear();
  for (const s of readMods(['.css'])) {
    try { keys.set(s.name, await wc.insertCSS(s.code)); } catch (err) { log(`renderer css FAILED: ${s.name}:`, err); }
  }
}

function injectJs(wc) {
  const url = wc.getURL();
  for (const s of readMods(['.js'])) {
    const wrapped = `(() => { try {\n${s.code}\n} catch (e) { console.error('[vre] ${s.name}', e); } })();\n//# sourceURL=vre-mod:///${s.name}`;
    wc.executeJavaScript(wrapped, true)
      .then(() => log(`renderer mod injected: ${s.name} -> ${url}`))
      .catch((err) => log(`renderer mod FAILED: ${s.name} -> ${url}:`, err));
  }
}

app.on('web-contents-created', (_event, wc) => {
  if (wc.getType() !== 'window') return; // skip webviews/background pages showing third-party content
  windows.set(wc, new Map());
  wc.once('destroyed', () => windows.delete(wc));
  wc.on('dom-ready', () => {
    windows.get(wc)?.clear(); // a new document has none of the old inserted CSS
    applyCss(wc);
    injectJs(wc);
  });
});

if (env.VRE_NO_HOT_RELOAD !== '1') {
  let timer = null;
  const pending = new Set();
  try {
    fs.mkdirSync(rendererDir, { recursive: true });
    fs.watch(rendererDir, (_type, name) => {
      if (!name || name.startsWith('_') || !/\.(js|css)$/.test(name)) return;
      pending.add(name);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const names = [...pending];
        pending.clear();
        const js = names.some((n) => n.endsWith('.js'));
        log(`hot reload: ${names.join(', ')} changed -> ${js ? 'reloading windows' : 'swapping CSS'}`);
        for (const wc of windows.keys()) {
          if (wc.isDestroyed()) continue;
          if (js) wc.reload(); else applyCss(wc);
        }
      }, 150);
    });
    log(`hot reload: watching ${rendererDir}`);
  } catch (err) { log('hot reload FAILED to start:', err); }
}

// 5. Hand over to Voyager.
log(`starting original main: ${cfg.originalMain}`);
require(path.join(__dirname, cfg.originalMain));
