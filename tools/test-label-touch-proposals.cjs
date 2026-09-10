// Offline source and calculator checks. No browser, hardware, network or ERP writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.resolve(__dirname, '../prototypes/label-touch-proposals.html');
const html = fs.readFileSync(file, 'utf8');
assert.ok(Buffer.byteLength(html) < 1024 * 1024, 'Keep inline proposal under 1 MB');
assert.ok(!/<\/?(?:html|head|body)(?:\s|>)/i.test(html), 'Must be an HTML fragment');
assert.ok(!html.includes('\\"') && !html.includes('\\n'), 'Use literal markup and newlines');
assert.equal((html.match(/<section class="dbmt-proposal"/g) || []).length, 3);
for (const layout of ['balanced', 'scale', 'guided']) assert.ok(html.includes(`data-layout="${layout}"`));
assert.ok(html.includes("if(globalThis.Tweak)"), 'Host helper must be optional');
assert.ok(html.includes('aspect-ratio:5/4'), 'Preserve the 1280×1024 target proportions');
assert.ok(html.includes('aria-live="polite"'));
assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|requestPort|localStorage|sessionStorage)\b|window\.print|\.supabase\b/.test(html), 'Proposal must not access live services or devices');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
assert.equal(scripts.length, 1);
new vm.Script(scripts[0], { filename:file });
const start = scripts[0].indexOf('function calcResult');
const end = scripts[0].indexOf('const root = document.getElementById');
assert.ok(start >= 0 && end > start);
const { calcStep } = vm.runInNewContext(`(() => { ${scripts[0].slice(start,end)} return { calcStep }; })()`);
const run = keys => keys.reduce(calcStep, { value:'0', stored:null, operator:null, fresh:false }).value;
const cases = [
  [['5','+','3','='],'8'],
  [['1','2','−','4','='],'8'],
  [['2','.','5','×','4','='],'10'],
  [['1','0','÷','4','='],'2.5'],
  [['0','.','1','+','0','.','2','='],'0.3'],
  [['2','+','3','×','4','='],'20'],
  [['2','+','×','4','='],'8'],
  [['5','0','%'],'0.5'],
  [['1','2','⌫'],'1'],
  [['1','⌫'],'0'],
  [['1','÷','0','='],'오류'],
  [['1','÷','0','=','2'],'2'],
  [['1','+','2','=','4'],'4'],
  [['9','+','9','AC'],'0'],
  [['1','.','.','5'],'1.5'],
  [['1','2','3','4','5','6','7','8','9','0','1'],'1234567890']
];
for (const [keys, expected] of cases) assert.equal(run(keys),expected,keys.join(' '));
console.log(`PASS: 3 isolated UI proposals, script syntax, fragment contract, ${cases.length} calculator cases`);
