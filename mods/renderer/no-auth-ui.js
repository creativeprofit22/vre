// No sign-in, part 3 (UI): hide every "Sign in" / "Log in" control and the "you need to sign in"
// notes, in English and Spanish, as the page changes. API-key fields stay (keys are local, not sign-ins).
// The actual sign-in flows are blocked in mods/main/no-auth.cjs and mods/helpers/no-auth-browser.cjs.
const LABEL = /^(sign in|log in|login|sign up|connect voyager|use a different account|sign out|iniciar sesión|inicia sesión|registrarse|usar otra cuenta|cerrar sesión|ver planes|view plans)$/i;
const NOTE = /^(you need to sign in|sign in to (voyager )?continue\.?|debes iniciar sesión|inicia sesión para continuar\.?)$/i;

function sweep(root = document.body) {
  if (!root) return 0;
  let hidden = 0;
  for (const el of root.querySelectorAll('button, a, [role="button"], [role="menuitem"], p, span')) {
    if (el.dataset.vreNoAuth) continue;
    const text = (el.innerText || '').trim();
    if (!text || text.length > 60) continue;
    const isControl = el.matches('button, a, [role="button"], [role="menuitem"]');
    if ((isControl && LABEL.test(text)) || (!isControl && NOTE.test(text))) {
      el.dataset.vreNoAuth = '1';
      el.style.setProperty('display', 'none', 'important');
      hidden++;
    }
  }
  return hidden;
}

if (!window.__vreNoAuthUi) {
  window.__vreNoAuthUi = true;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; window.__vreNoAuthHidden = (window.__vreNoAuthHidden || 0) + sweep(); });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.__vreNoAuthHidden = sweep();
}
