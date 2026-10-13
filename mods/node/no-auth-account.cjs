// No sign-in, part 4 (data layer, every Voyager Node process): the copy has no Voyager (Moda) account.
// Voyager reads the signed-in account from <home>/media/moda.json in at least eight places across the
// backend server, the media service and the CLI, and treats `null` there as signed out ("logout leaves
// `null` in the same file"). This mod makes reads of that one file return `null`, so every reader sees
// the signed-out state. Nothing on disk is changed or deleted; rename to _no-auth-account.cjs to undo.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function noAuthAccount({ log, home, proc }) {
  if (!home) return;
  const target = path.resolve(home, 'media', 'moda.json').toLowerCase();
  const isAccountFile = (p) => {
    try {
      const s = p instanceof URL ? p.pathname.replace(/^\/([A-Za-z]:)/, '$1') : typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : null;
      return s !== null && path.resolve(s).toLowerCase() === target;
    } catch { return false; }
  };
  const NULL = 'null';
  const as = (opts) => (opts === undefined || opts === null || (typeof opts === 'object' && !opts.encoding) ? Buffer.from(NULL) : NULL);
  let reported = false;
  const hit = () => { if (!reported) { reported = true; log(`no-auth-account: ${proc} read moda.json -> signed out`); } };

  const { readFile, readFileSync } = fs;
  fs.readFileSync = function (p, opts) { if (isAccountFile(p)) { hit(); return as(opts); } return readFileSync.apply(this, arguments); };
  fs.readFile = function (p, opts, cb) {
    if (isAccountFile(p)) { hit(); const done = typeof opts === 'function' ? opts : cb; const o = typeof opts === 'function' ? undefined : opts; process.nextTick(done, null, as(o)); return; }
    return readFile.apply(this, arguments);
  };
  const promises = fs.promises;
  const pReadFile = promises.readFile;
  promises.readFile = function (p, opts) { if (isAccountFile(p)) { hit(); return Promise.resolve(as(opts)); } return pReadFile.apply(this, arguments); };
  try { require('node:module').syncBuiltinESMExports(); } catch {}
  log(`no-auth-account: ${proc} sees ${target} as signed out`);
};
