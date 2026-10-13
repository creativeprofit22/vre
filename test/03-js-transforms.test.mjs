// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { tokenize } from '../stages/03-js/lib/tokenize.mjs';
import { beautify } from '../stages/03-js/lib/beautify.mjs';
import { deobfuscate } from '../stages/03-js/lib/deobfuscate.mjs';

/** @param {string} s */
const sig = (s) => tokenize(s).filter((t) => t.type !== 'ws' && t.type !== 'comment').map((t) => `${t.type}:${t.value}`);
/** @param {string} s */
const types = (s) => tokenize(s).filter((t) => t.type !== 'ws').map((t) => [t.type, t.value]);

const SNIPPETS = [
  '#!/usr/bin/env node\nvar a=1,b=2;function f(x){return x+1}console.log(f(a)/b/2)',
  'for(var i=0,j=10;i<j;i++){if(i%2)continue;else{j--}}',
  'var x=/re[/]x/g.test("a/re/x"),y=`a${`b${1+{a:1}.a}`}c`;',
  'a=b\n++c',
  'function g(){return\n1}',
  'let q=a+ +b-(-c)-(--d);x=a in y;z=1..toString()+1.5.toFixed(1);',
  'label:for(;;){break label}var o={a:1,"b":[2,3],c(){return!0},get d(){return void 0}};',
  'class A extends B{#p=1;static s(){return this.#p}}async function h(){await x;for await(const y of z);}',
  'x=a?b:c;y=a??b;z=a?.b?.[c]?.(d);w=a=>b=>c;/* c */ //d\nv=typeof x;',
  'switch(a){case 1:b();break;default:c()}try{t()}catch(e){}finally{f()}do x++;while(x<3)',
];

test('tokenizer is lossless', () => {
  for (const s of [...SNIPPETS, 'a/b/c', '`unterminated ${x', '"\\\r\nx"', 'x = 0x1F + 1e-3 + .5 + 10n']) {
    assert.equal(tokenize(s).map((t) => t.value).join(''), s);
  }
});

test('regex vs division', () => {
  assert.deepEqual(types('a/b/c').map((t) => t[0]), ['name', 'punct', 'name', 'punct', 'name']);
  assert.deepEqual(types('x=/re/g'), [['name', 'x'], ['punct', '='], ['regex', '/re/g']]);
  assert.deepEqual(types('return /a/.test(s)').slice(0, 3), [['name', 'return'], ['regex', '/a/'], ['punct', '.']]);
  assert.deepEqual(types('(a)/2').map((t) => t[0]), ['punct', 'name', 'punct', 'punct', 'number']);
  assert.deepEqual(types('[/]/]'), [['punct', '['], ['regex', '/]/'], ['punct', ']']]);
  assert.deepEqual(types('x=/[/]/'), [['name', 'x'], ['punct', '='], ['regex', '/[/]/']]);
  assert.deepEqual(types('a/=2'), [['name', 'a'], ['punct', '/='], ['number', '2']]);
});

test('nested templates are one token', () => {
  const s = 'a${b`${c}`}';
  assert.deepEqual(types('`' + s + '`'), [['template', '`' + s + '`']]);
  assert.deepEqual(types('`${{a:"}"}.a}`+1').map((t) => t[0]), ['template', 'punct', 'number']);
  assert.deepEqual(types('`${/}/.source}`;x').map((t) => t[0]), ['template', 'punct', 'name']);
});

test('beautify keeps token sequence and compiles', () => {
  for (const s of SNIPPETS) {
    const out = beautify(s);
    assert.deepEqual(sig(out), sig(s), out);
    if (!s.includes('await x')) new vm.Script(out.replace(/^#!.*/, ''));
  }
  const out = beautify('function f(){if(a){b()}else{c()}return 1}');
  assert.match(out, /\n  if \(a\) \{\n    b\(\)\n  \} else \{/);
});

test('beautify preserves ASI semantics and results', () => {
  const cases = [
    'var a=1,b=2,c=3;var r=[];r.push(a+ +b,a- -b,a-(-b));r.push(1..toString());r',
    'var c=1,a=5\n++c\n;[a,c]',
    '(function(){return\n42})()',
    'var o={x:1,f(){return this.x+!0}};var s=0;for(var i=0;i<3;i++){s+=o.f()}s+"/"+/a\\/b/.source',
    'var t=`x${[1,2].map(n=>`<${n}>`).join("")}`;t',
  ];
  for (const s of cases) {
    const out = beautify(s);
    assert.deepEqual(sig(out), sig(s));
    assert.equal(JSON.stringify(vm.runInNewContext(out)), JSON.stringify(vm.runInNewContext(s)), out);
  }
});

test('deobfuscate !0 / !1', () => {
  const r = deobfuscate('return!0,x=!1,y=!0.5,z=!10');
  assert.equal(r.code, 'return true,x=false,y=!0.5,z=!10');
  assert.equal(r.changes.notZeroToTrue, 1);
  assert.equal(r.changes.notOneToFalse, 1);
  assert.equal(deobfuscate('!0 .toString()').code, '!0 .toString()');
});

test('deobfuscate void 0', () => {
  assert.equal(deobfuscate('a=void 0;b=void 0===c').code, 'a=undefined;b=undefined===c');
  assert.equal(deobfuscate('a=void 1').code, 'a=void 1');
  assert.equal(deobfuscate('var undefined=1;a=void 0').code, 'var undefined=1;a=void 0');
});

test('deobfuscate numbers', () => {
  const r = deobfuscate('a=0x1F+0o17+0b101+0XfF;b=0x10.toString();c=0x1fn;d=1.5');
  assert.equal(r.code, 'a=31+15+5+255;b=0x10.toString();c=0x1fn;d=1.5');
  assert.equal(r.changes.numberToDecimal, 4);
});

test('deobfuscate string escapes', () => {
  const r = deobfuscate(String.raw`a="\x41\u0042c";b='\x27\x22\x5c\x0a\u2028';c="\\x41"`);
  assert.equal(r.code, String.raw`a="ABc";b='\x27\x22\x5c\x0a\u2028';c="\\x41"`);
  assert.equal(r.changes.stringEscapesDecoded, 2);
});

test('deobfuscate signals and embedded wasm', () => {
  const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(4000, 7)]).toString('base64');
  const strs = Array.from({ length: 60 }, (_, i) => `'s${i}'`).join(',');
  const src = `var _0x1a=[${strs}];(function(a,b){a['push'](a['shift']())})(_0x1a,1);eval("1");new Function("x");Function("y");var w="${wasm}";`;
  const r = deobfuscate(src);
  assert.equal(r.signals.uniqueObfuscatorIdentifiers, 1);
  assert.equal(r.signals.obfuscatorIdentifiers, 2);
  assert.equal(r.signals.stringArray, true);
  assert.equal(r.signals.rotateIIFE, true);
  assert.equal(r.signals.eval, 1);
  assert.equal(r.signals.newFunction, 1);
  assert.equal(r.signals.functionCall, 1);
  assert.equal(r.signals.embedded.length, 1);
  const e = r.signals.embedded[0];
  assert.equal(e.kind, 'wasm');
  assert.equal(src.slice(e.start, e.end), wasm);
  assert.equal(e.length, wasm.length);
  assert.equal(deobfuscate('var s="abc"').signals.embedded.length, 0);
});
