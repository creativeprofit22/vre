// No sign-in, part 2 (process launches): if any process is started to open a sign-in page in the
// browser (cmd start, rundll32, explorer, powershell Start-Process, ...), swap it for a no-op.
// Covers sign-ins the backend server starts itself (agent CLIs, connectors). See mods/main/no-auth.cjs.
const { isSignInUrl } = require('../main/no-auth.cjs');

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

module.exports = function noAuthBrowser(call, { log }) {
  const text = [call.file, ...call.args].map(String).join(' ');
  const hit = (text.match(URL_RE) || []).find(isSignInUrl);
  if (!hit) return;
  log(`no-auth: blocked sign-in launch [${call.proc}] ${call.api} ${call.file} -> ${hit}`);
  if (call.api === 'exec' || call.api === 'execSync') { call.file = 'exit 0'; return; }
  call.file = process.env.ComSpec || 'cmd.exe';
  call.args = ['/d', '/c', 'exit 0'];
  call.options = { ...call.options, shell: false };
};
