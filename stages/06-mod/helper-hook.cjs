'use strict';
// vre helper hook. Wraps node:child_process so mods can see and change every process launch
// (log it, rewrite args/env/stdio, or point it at a replacement binary).
// Copied by stage 06-mod to <copy>/resources/vre-helper-hook.cjs. Loaded by the vre loader in the
// main process, and passed to Voyager's own Node children (the backend server) through
// NODE_OPTIONS=--require, so launches made by the server are hooked too.
//
// Helper mods: CommonJS files in <mods>/helpers/*.cjs|*.js exporting `function (call, ctx)`.
//   call = { api, file, args, options, helper, pid: <launching pid>, proc: 'main' | 'server' | ... }
//   - api: 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'exec' | 'execSync' | 'fork'
//   - helper: binary name (e.g. 'voyager-dictation') when the file lives inside the Voyager install, else null
//   - change call.file / call.args / call.options (env, stdio, cwd...) in place; the launch uses the result
//   ctx = { log, installDir, proc }
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const MARK = Symbol.for('vre.helperHook');
const APIS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

function normalize(api, argv) {
  const a = [...argv];
  if (api === 'exec' || api === 'execSync') {
    const cb = typeof a[a.length - 1] === 'function' ? a.pop() : undefined;
    return { file: String(a[0]), args: [], options: a[1] && typeof a[1] === 'object' ? { ...a[1] } : {}, cb, shell: true };
  }
  const cb = typeof a[a.length - 1] === 'function' ? a.pop() : undefined;
  const file = a[0];
  let args = [];
  let options = {};
  if (Array.isArray(a[1])) { args = [...a[1]]; if (a[2] && typeof a[2] === 'object') options = { ...a[2] }; } else if (a[1] && typeof a[1] === 'object') options = { ...a[1] };
  return { file, args, options, cb };
}

function denormalize(api, call, n) {
  if (api === 'exec' || api === 'execSync') return [call.file, call.options, ...(n.cb ? [n.cb] : [])];
  return [call.file, call.args, call.options, ...(n.cb ? [n.cb] : [])];
}

/** Name of a binary that ships inside the Voyager install (e.g. 'voyager-dictation'), else null. */
function helperName(file, installDir) {
  if (typeof file !== 'string' || !installDir) return null;
  const abs = path.resolve(file);
  if (!abs.toLowerCase().startsWith(installDir.toLowerCase() + path.sep)) return null;
  return path.basename(abs).replace(/\.exe$/i, '');
}

function loadHelperMods(dir, log) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const mods = [];
  for (const n of names.filter((x) => /\.c?js$/.test(x) && !x.startsWith('_')).sort()) {
    try {
      const m = require(path.join(dir, n));
      const fn = typeof m === 'function' ? m : typeof m?.default === 'function' ? m.default : null;
      if (fn) mods.push({ name: n, fn });
    } catch (err) { log(`helper mod FAILED to load: ${n}:`, err); }
  }
  return mods;
}

/**
 * Install the hook once per process. opts: { log, modsDir, installDir, proc, hookFile, extraHandlers }
 * Returns { handlers } (an array; push more functions to it at runtime).
 */
function install(opts = {}) {
  if (cp[MARK]) return cp[MARK];
  const log = opts.log || (() => {});
  const proc = opts.proc || 'main';
  const installDir = opts.installDir || path.dirname(process.execPath);
  const handlers = [...(opts.extraHandlers || [])];
  if (opts.modsDir) for (const m of loadHelperMods(path.join(opts.modsDir, 'helpers'), log)) { handlers.push(Object.assign((c, x) => m.fn(c, x), { modName: m.name })); log(`helper mod loaded (${proc}): ${m.name}`); }
  const ctx = { log, installDir, proc };
  const state = { handlers, ctx };

  for (const api of APIS) {
    const orig = cp[api];
    if (typeof orig !== 'function') continue;
    const wrapped = function vreHooked(...argv) {
      let n;
      try { n = normalize(api, argv); } catch { return orig.apply(this, argv); }
      const call = { api, file: n.file, args: n.args, options: n.options, helper: helperName(n.file, installDir), pid: process.pid, proc };
      // Carry the hook into Voyager's own Node children (Voyager.exe with ELECTRON_RUN_AS_NODE=1, e.g. the backend server).
      if (opts.hookFile && typeof call.file === 'string' && path.resolve(call.file).toLowerCase() === process.execPath.toLowerCase()) {
        const env = { ...(call.options.env || process.env) };
        if (env.ELECTRON_RUN_AS_NODE === '1' && !String(env.NODE_OPTIONS || '').includes(path.basename(opts.hookFile))) {
          // Forward slashes: NODE_OPTIONS treats backslashes inside quotes as escapes (E:\a\b -> E:ab).
          env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require "${opts.hookFile.replace(/\\/g, '/')}"`;
          env.VRE_HELPER_HOOK_MODS = opts.modsDir || '';
          env.VRE_HELPER_HOOK_LOG = opts.logFile || '';
          call.options.env = env;
        }
      }
      for (const h of handlers) {
        try { h(call, ctx); } catch (err) { log(`helper mod FAILED: ${h.modName || 'handler'} on ${api} ${call.file}:`, err); }
      }
      return orig.apply(this, denormalize(api, call, n));
    };
    Object.defineProperty(wrapped, 'name', { value: api });
    cp[api] = wrapped;
  }
  try { require('node:module').syncBuiltinESMExports(); } catch {}
  Object.defineProperty(cp, MARK, { value: state });
  return state;
}

/**
 * Node mods: CommonJS files in <mods>/node/*.cjs|*.js, run in the main process and in every Voyager Node
 * child (backend server, media service) before Voyager's own code. Export `function (ctx)`;
 * ctx = { log, home, proc, installDir }. Use them for process-wide changes (fs, net, env).
 */
function loadNodeMods(modsDir, ctx) {
  if (!modsDir) return;
  const dir = path.join(modsDir, 'node');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names.filter((x) => /\.c?js$/.test(x) && !x.startsWith('_')).sort()) {
    try {
      const m = require(path.join(dir, n));
      const fn = typeof m === 'function' ? m : typeof m?.default === 'function' ? m.default : null;
      if (fn) fn(ctx);
      ctx.log(`node mod loaded (${ctx.proc}): ${n}`);
    } catch (err) { ctx.log(`node mod FAILED (${ctx.proc}): ${n}:`, err); }
  }
}

module.exports = { install, loadNodeMods, helperName, normalize, denormalize };

// Loaded via NODE_OPTIONS=--require in a Voyager Node child: install with env-provided settings.
if (require.main !== module && process.env.ELECTRON_RUN_AS_NODE === '1' && process.env.VRE_HELPER_HOOK_MODS !== undefined && !cp[MARK]) {
  const logFile = process.env.VRE_HELPER_HOOK_LOG;
  const log = (...args) => {
    if (!logFile) return;
    const line = `[vre ${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ')}`;
    try { fs.appendFileSync(logFile, `${line}\n`); } catch {}
  };
  const installDir = path.dirname(process.execPath);
  const modsDir = process.env.VRE_HELPER_HOOK_MODS || null;
  const proc = `node-child:${process.pid}`;
  install({ log, modsDir, installDir, proc, hookFile: __filename, logFile });
  loadNodeMods(modsDir, { log, home: process.env.VOYAGER_HOME || null, proc, installDir });
  // Don't leak the preload into unrelated grandchildren (user terminals, other Node installs); the
  // wrapper re-adds it only for Voyager's own Node children.
  const self = path.basename(__filename).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rest = String(process.env.NODE_OPTIONS || '').replace(new RegExp(`\\s*--require\\s+"[^"]*${self}"`, 'g'), '').trim();
  if (rest) process.env.NODE_OPTIONS = rest; else delete process.env.NODE_OPTIONS;
  delete process.env.VRE_HELPER_HOOK_MODS;
  delete process.env.VRE_HELPER_HOOK_LOG;
  log(`helper hook active in node child pid=${process.pid} (${process.argv.slice(1, 2).join(' ')})`);
}
