// Isolation fix (helper mod example: rewriting env). The bundled api-models.exe (OpenCode) keeps its
// database, config and logs in the user's shared XDG folders (~/.local/share/opencode, ...), which the
// real Voyager and any standalone OpenCode also use. In the copy, point them at the copy's own data
// home instead, so the copy never reads or migrates the real app's OpenCode database.
const path = require('node:path');

const XDG = { XDG_DATA_HOME: 'share', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' };

module.exports = function isolateApiModels(call, { log }) {
  if (call.helper !== 'api-models') return;
  const home = process.env.VOYAGER_HOME; // set by the vre loader to the copy's data home, inherited by children
  if (!home) return;
  const env = { ...(call.options.env || process.env) };
  const root = path.join(home, 'api-models');
  for (const [key, sub] of Object.entries(XDG)) env[key] = path.join(root, sub);
  call.options.env = env;
  log(`isolate-api-models: ${call.args[0] ?? ''} -> XDG dirs under ${root}`);
};
