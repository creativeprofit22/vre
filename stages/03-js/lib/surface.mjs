// @ts-check
// Pure scans for the app's callable surface: HTTP routes, RPC method tables,
// contextBridge members (with the IPC channels they reach), IPC sender checks
// and native-addon loads. Regex/brace-matching best effort on compiled JS.

const HTTP = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
const PATH_OK = /^\/[\w\-./{}:*@~%+]*$/;
const MIME_ROOT = /^(?:image|video|audio|text|application|font|model|multipart|message)\//;

/**
 * Index just past the end of the string/template literal that starts at `i`.
 * @param {string} code @param {number} i
 */
function skipString(code, i) {
  const q = code[i];
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === '\\') { j++; continue; }
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && code[j + 1] === '{') j = skipBalanced(code, j + 1) - 1;
    else if (q !== '`' && c === '\n') return j;
  }
  return code.length;
}

/**
 * From an opening bracket at `i`, return the index just past its matching close.
 * @param {string} code @param {number} i
 */
export function skipBalanced(code, i) {
  const open = code[i];
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(code, j) - 1; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) return c === close ? j + 1 : j + 1; }
  }
  return code.length;
}

/**
 * Text inside the object literal whose `{` is at `i` (without the braces).
 * @param {string} code @param {number} i
 */
export function objectBody(code, i) {
  return code.slice(i + 1, skipBalanced(code, i) - 1);
}

/**
 * Top-level properties of an object-literal body: key plus value text.
 * Method shorthand (`name(x) { }`) and spreads are handled; computed keys are kept as `[expr]`.
 * @param {string} body
 * @returns {{ key: string, value: string, spread?: boolean }[]}
 */
export function objectProps(body) {
  /** @type {{ key: string, value: string, spread?: boolean }[]} */
  const out = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    let key = '';
    if (body.startsWith('...', i)) {
      let j = i + 3;
      while (j < n && body[j] !== ',') { const c = body[j]; if ('{(['.includes(c)) j = skipBalanced(body, j); else if (c === '"' || c === "'" || c === '`') j = skipString(body, j); else j++; }
      out.push({ key: body.slice(i + 3, j).trim(), value: '', spread: true });
      i = j;
      continue;
    }
    const c0 = body[i];
    if (c0 === '"' || c0 === "'") { const e = skipString(body, i); key = body.slice(i + 1, e - 1); i = e; }
    else if (c0 === '[') { const e = skipBalanced(body, i); key = body.slice(i, e); i = e; }
    else {
      const m = /^(?:(?:async|get|set|static)\s+)?\*?\s*([\w$]+)/.exec(body.slice(i, i + 200));
      if (!m) { i++; continue; }
      key = m[1]; i += m[0].length;
    }
    while (i < n && /\s/.test(body[i])) i++;
    let start = i;
    if (body[i] === ':') start = ++i;
    // value runs to the next top-level comma
    let j = start;
    while (j < n && body[j] !== ',') {
      const c = body[j];
      if (c === '{' || c === '(' || c === '[') j = skipBalanced(body, j);
      else if (c === '"' || c === "'" || c === '`') j = skipString(body, j);
      else j++;
    }
    out.push({ key, value: body.slice(start, j).trim() });
    i = j + 1;
  }
  return out;
}

/**
 * HTTP routes served or called by this file.
 * kind: `serve` (router registration / request-URL check in an HTTP handler) or `call` (outbound request).
 * @param {string} code
 * @returns {{ kind: 'serve'|'call', method: string, path: string, via: string }[]}
 */
export function scanRoutes(code) {
  /** @type {{ kind: 'serve'|'call', method: string, path: string, via: string }[]} */
  const out = [];
  const seen = new Set();
  const add = (/** @type {'serve'|'call'} */ kind, /** @type {string} */ method, /** @type {string} */ path, /** @type {string} */ via) => {
    if (!PATH_OK.test(path) || path.length > 160) return;
    const k = `${kind} ${method} ${path}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ kind, method, path, via });
  };
  // router registrations: add("GET", "/health", ...), route("*", "/mcp/integrations", ...)
  for (const m of code.matchAll(new RegExp(`\\(\\s*["'](${HTTP}|\\*)["']\\s*,\\s*["'](\\/[^"'\\s]*)["']`, 'g'))) add('serve', m[1], m[2], 'router');
  // MCP/HTTP layers configured with a path
  for (const m of code.matchAll(/\blayerHttp[\w$]*\(\s*\{[^{}]{0,400}?\bpath\s*:\s*["'](\/[^"'\s]*)["']/g)) add('serve', '*', m[1], 'http-layer');
  // hand-written handlers: req.url !== "/control", url.pathname === "/callback"
  for (const m of code.matchAll(/\b[\w$]+\.(url|pathname)\s*[!=]==?\s*["'](\/[^"'\s]*)["']/g)) {
    const at = m.index ?? 0;
    const win = code.slice(Math.max(0, at - 250), at + 250);
    const meth = new RegExp(`\\.method\\s*[!=]==?\\s*["'](${HTTP})["']`).exec(win);
    add('serve', meth?.[1] ?? '*', m[2], `${m[1]} check`);
  }
  // outbound request objects: { socketPath, path: "/vm", method: "POST" } or { method: "POST", path: "/render/jobs" }
  for (const m of code.matchAll(/\bpath\s*:\s*["'`](\/[^"'`\s$]*)["'`]/g)) {
    const at = m.index ?? 0;
    const lo = code.lastIndexOf('{', at);
    let hi = code.indexOf('}', at);
    if (hi < 0) hi = Math.min(code.length, at + 300);
    const obj = code.slice(Math.max(lo, at - 400), Math.min(hi, at + 400));
    const meth = new RegExp(`\\bmethod\\s*:\\s*["'](${HTTP})["']`).exec(obj);
    if (meth || /\bsocketPath\b/.test(obj)) add('call', meth?.[1] ?? '*', m[1], /\bsocketPath\b/.test(obj) ? 'socket request' : 'request object');
  }
  // generated API clients: client.delete({ url: "/mcp/{name}/auth", ... })
  for (const m of code.matchAll(/\.(get|post|put|patch|delete|head|options)\(\s*\{\s*url\s*:\s*["'](\/[^"'\s]*)["']/g)) add('call', m[1].toUpperCase(), m[2], 'api client');
  // versioned/API paths handed to a request helper or appended to a base URL
  for (const m of code.matchAll(/\b[\w$]*(?:request|fetch|fetcher|get|post|call|api)[\w$]*\(\s*["'`](\/(?:v\d+|api)\/[^"'`\s$]*)["'`]/gi)) add('call', '*', m[1], 'request helper');
  for (const m of code.matchAll(/\$\{[^{}`]{1,60}\}(\/(?:v\d+|api)\/[\w\-./{}]*)/g)) add('call', '*', m[1], 'template url');
  return out;
}

/**
 * RPC surfaces: method tables (`const WS_METHODS = { a: "ns.method", ...OTHER_METHODS }`)
 * and JSON-RPC style `method: "thread/start"` literals.
 * @param {string} code
 */
export function scanRpc(code) {
  /** @type {{ name: string, methods: string[], spreads: string[] }[]} */
  const tables = [];
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*(?:METHODS?|RPCS?))\s*=\s*\{/g)) {
    const props = objectProps(objectBody(code, (m.index ?? 0) + m[0].length - 1));
    const methods = [];
    const spreads = [];
    for (const p of props) {
      if (p.spread) { if (/^[A-Z][A-Z0-9_]*$/.test(p.key)) spreads.push(p.key); continue; }
      const v = /^["']([^"'\n]+)["']$/.exec(p.value);
      if (v) methods.push(v[1]);
    }
    if (methods.length || spreads.length) tables.push({ name: m[1], methods, spreads });
  }
  const jsonRpc = new Set();
  for (const m of code.matchAll(/\bmethod\s*:\s*(?:[\w$]*Literal[\w$]*\(\s*)?["']([a-z][\w-]*(?:\/[\w-]+)+)["']/g)) {
    if (!MIME_ROOT.test(m[1])) jsonRpc.add(m[1]);
  }
  return { tables, jsonRpc: [...jsonRpc].sort() };
}

/**
 * Members of each `contextBridge.exposeInMainWorld(name, {...})` object, flattened to dotted paths,
 * with the IPC channel constants each member's code refers to (resolved through `consts`).
 * @param {string} code
 * @param {Map<string,string>} consts
 * @returns {{ api: string, members: { path: string, channels: string[] }[] }[]}
 */
export function bridgeMembers(code, consts) {
  const out = [];
  for (const m of code.matchAll(/\bexposeInMainWorld\s*\(\s*["']([^"']+)["']\s*,\s*/g)) {
    let at = (m.index ?? 0) + m[0].length;
    if (code[at] !== '{') {
      // identifier argument: find its object-literal declaration
      const id = /^[\w$]+/.exec(code.slice(at, at + 80))?.[0];
      const decl = id ? new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=\\s*\\{`).exec(code) : null;
      if (!decl) { out.push({ api: m[1], members: [] }); continue; }
      at = (decl.index ?? 0) + decl[0].length - 1;
    }
    /** @type {{ path: string, channels: string[] }[]} */
    const members = [];
    const walk = (/** @type {string} */ body, /** @type {string} */ prefix, /** @type {number} */ depth) => {
      for (const p of objectProps(body)) {
        if (p.spread) continue;
        const path = prefix ? `${prefix}.${p.key}` : p.key;
        if (p.value.startsWith('{') && depth < 4) { walk(objectBody(p.value, 0), path, depth + 1); continue; }
        const channels = new Set();
        for (const x of p.value.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) { const v = consts.get(x[1]); if (v) channels.add(v); }
        for (const x of p.value.matchAll(/\bipcRenderer\.\w+\(\s*["']([^"'\n]+)["']/g)) channels.add(x[1]);
        members.push({ path, channels: [...channels].sort() });
      }
    };
    walk(objectBody(code, at), '', 0);
    out.push({ api: m[1], members });
  }
  return out;
}

/**
 * IPC sender validation: frame-identity comparisons, frame/sender URL reads and calls to
 * `ensure/assert/validate/verify/is/check...Sender` helpers. Observations only.
 * @param {string} code
 * @returns {{ kind: string, name: string, count: number }[]}
 */
export function senderChecks(code) {
  /** @type {Map<string, {kind: string, name: string, count: number}>} */
  const m = new Map();
  const bump = (/** @type {string} */ kind, /** @type {string} */ name) => {
    const k = `${kind}|${name}`;
    const e = m.get(k) ?? { kind, name, count: 0 };
    e.count++; m.set(k, e);
  };
  for (const _ of code.matchAll(/\bsenderFrame\s*[!=]==?|[!=]==?\s*[\w$.]*\bsenderFrame\b/g)) bump('frame-identity', 'senderFrame comparison');
  for (const x of code.matchAll(/\bsenderFrame\??\.(url|origin)\b/g)) bump('frame-url', `senderFrame.${x[1]}`);
  for (const _ of code.matchAll(/\bsender\??\.getURL\(\)/g)) bump('sender-url', 'sender.getURL()');
  for (const x of code.matchAll(/(?<!function\s+)\b((?:ensure|assert|validate|verify|is|check)[A-Z][\w$]*Sender[\w$]*)\s*\(/g)) bump('helper', x[1]);
  return [...m.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/**
 * Native-addon loads in first-party code: `require("x.node")` and `process.dlopen`.
 * @param {string} code
 */
export function addonLoads(code) {
  const requires = [...new Set([...code.matchAll(/\brequire\(\s*["']([^"']+\.node)["']\s*\)/g)].map((m) => m[1]))].sort();
  const dlopen = [...code.matchAll(/\bprocess\.dlopen\s*\(/g)].length;
  return { requires, dlopen };
}

/**
 * Loader package for a platform-specific prebuilt package name
 * (`@napi-rs/keyring-win32-x64-msvc` -> `@napi-rs/keyring`).
 * @param {string} name
 */
export function addonBasePackage(name) {
  return name.replace(/-(?:win32|darwin|linux|freebsd|android)-(?:x64|arm64|ia32|arm|universal)(?:-(?:msvc|gnu|musl|gnueabihf))?$/, '');
}
