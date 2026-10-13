// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beautify, guessModule, tokenize } from '../stages/04-native/lib/beautify.mjs';

const kinds = (/** @type {string} */ s) => tokenize(s).filter((t) => t.kind !== 'ws').map((t) => `${t.kind}:${t.text}`);

test('tokenize: strings containing braces, semicolons and escaped quotes stay one token', () => {
  assert.deepEqual(kinds(`a="{;}",b='}\\'{'`), ['word:a', 'punct:=', 'str:"{;}"', 'punct:,', "word:b", 'punct:=', "str:'}\\'{'"]);
});

test('tokenize: regex literals vs division', () => {
  assert.deepEqual(kinds('x=/[/{]+;/g.test(y)'), ['word:x', 'punct:=', 're:/[/{]+;/g', 'punct:.', 'word:test', 'punct:(', 'word:y', 'punct:)']);
  assert.deepEqual(kinds('a=b/c/d'), ['word:a', 'punct:=', 'word:b', 'punct:/', 'word:c', 'punct:/', 'word:d']);
  assert.ok(kinds('return/}/.test(s)').includes('re:/}/'));
  assert.ok(kinds('f(a)/2').includes('punct:/'));
});

test('tokenize: template literals with nested ${} and braces inside', () => {
  const t = kinds('s=`a{${o.x?{k:1}:`in${"}"}`}b;`;');
  assert.equal(t[2], 'tpl:`a{${');
  assert.ok(t.includes('tpl:`in${') && t.includes('str:"}"') && t.includes('tpl:}b;`'));
  assert.equal(t[t.length - 1], 'punct:;');
});

test('tokenize: comments are not code', () => {
  assert.deepEqual(kinds('a;/* { */b// }\nc'), ['word:a', 'punct:;', 'comment:/* { */', 'word:b', 'comment:// }', 'word:c']);
});

test('beautify: breaks after ; { } and indents by depth, keeps for(;;) on one line', () => {
  const { code, ok } = beautify('function f(){for(let i=0;i<2;i++){g("{;}")}return 1}f();');
  assert.equal(ok, true);
  assert.equal(code, 'function f(){\n  for(let i=0;i<2;i++){\n    g("{;}")\n  }\n  return 1\n}\nf();\n');
});

test('beautify: code inside parens (IIFE, callbacks) is still broken into lines', () => {
  const { code } = beautify('(()=>{a();b()})();');
  assert.equal(code, '(()=>{\n  a();\n  b()\n})();\n');
});

test('beautify: odd input falls back to the original', () => {
  for (const bad of ['a="unterminated', 'x=`open ${', 'f(){', '}}', '/* never closed']) {
    const r = beautify(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.code, bad);
    assert.ok(r.error);
  }
});

test('guessModule: regions, package paths, non-JS', () => {
  assert.match(guessModule('chunk-a.js', '//#region node_modules/zod/index.js\nx\n//#endregion'), /regions \(1\): zod/);
  assert.equal(guessModule('_up/node_modules/.bun/x/node_modules/@opentui/core/p.js', ''), 'package @opentui/core');
  assert.match(guessModule('chunk-b.js', 'import x from"node:fs";fetch("https://api.example.com/v1")'), /imports node:fs; urls https:\/\/api\.example\.com/);
  assert.equal(guessModule('tree-sitter-bash-hq5s6fxb.wasm'), 'WebAssembly module: tree-sitter bash grammar');
});
