// Sample renderer mod: a visible "VRE MOD" badge in every Voyager window.
// Renderer mods are plain browser scripts run in the page at dom-ready (wrapped in try/catch by the loader).
if (!document.getElementById('vre-mod-badge')) {
  const badge = document.createElement('div');
  badge.id = 'vre-mod-badge';
  badge.textContent = 'VRE MOD';
  badge.title = 'Injected by mods/renderer/sample-badge.js';
  Object.assign(badge.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    padding: '6px 10px', borderRadius: '8px', font: '600 12px/1 system-ui, sans-serif',
    color: '#fff', background: '#d6336c', boxShadow: '0 2px 8px rgba(0,0,0,.35)', pointerEvents: 'none',
  });
  document.documentElement.appendChild(badge);
  console.log('[vre] sample-badge injected');
}
