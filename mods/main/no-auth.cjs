// No sign-in, part 1 (main process): the copy runs locally without signing in to anything.
// - The default patches (mods/patches.json, ids no-auth-*) skip the setup wizard's account step, hide
//   the sidebar sign-in/avatar and make the backend report no Voyager (Moda) account.
// - This mod blocks every external sign-in page Voyager would open in the browser: OAuth/OpenID
//   providers (ChatGPT/Codex, Claude, Google, GitHub, Microsoft, Clerk, Moda, Higgsfield, ...).
// - mods/helpers/no-auth-browser.cjs does the same for browser launches made by child processes.
// Rename this file to _no-auth.cjs to turn it off.
const AUTH_HOSTS = [
  /(^|\.)auth\.openai\.com$/, /(^|\.)auth0\.com$/, /(^|\.)clerk\.[a-z.]+$/, /(^|\.)clerk\.accounts\.dev$/, /(^|\.)accounts\.dev$/,
  /(^|\.)accounts\.google\.com$/, /(^|\.)login\.microsoftonline\.com$/, /(^|\.)login\.live\.com$/, /(^|\.)appleid\.apple\.com$/,
  /(^|\.)okta\.com$/, /(^|\.)workos\.com$/, /(^|\.)stytch\.com$/,
];
const AUTH_PATH = /\/(oauth2?|authorize|auth\/callback|login|log-in|signin|sign-in|sign_in|signup|sign-up|sso|device|activate)(\/|$|\?|#)/i;
const AUTH_QUERY = /[?&](client_id|redirect_uri|response_type|code_challenge)=/i;

function isSignInUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return /sign-in\.html$/i.test(u.pathname); // Higgsfield's local sign-in page
  if (AUTH_HOSTS.some((re) => re.test(u.hostname))) return true;
  return AUTH_PATH.test(u.pathname) || AUTH_QUERY.test(u.search);
}

function noAuth({ electron, log }) {
  const { shell } = electron;
  const original = shell.openExternal.bind(shell);
  shell.openExternal = (url, options) => {
    if (isSignInUrl(url)) {
      log(`no-auth: blocked sign-in page ${String(url).slice(0, 160)}`);
      return Promise.reject(new Error('Sign-in is turned off in this local Voyager copy.'));
    }
    return original(url, options);
  };
  log('no-auth: external sign-in pages are blocked');
}

module.exports = noAuth;
module.exports.isSignInUrl = isSignInUrl;
