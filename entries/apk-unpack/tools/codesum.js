// Summarise dexcode.js output: per class, list method names and distinct string refs.
// usage: node codesum.js <core-code.txt> <classRegex>
const fs = require('fs');
const txt = fs.readFileSync(process.argv[2], 'utf8');
const re = process.argv[3] ? new RegExp(process.argv[3]) : null;
const lines = txt.split(/\r?\n/);
let cur = null;
const out = [];
for (const ln of lines) {
  if (ln.startsWith('### ')) {
    cur = { cls: ln.slice(4).replace(/\s+\(.*\)$/, ''), src: (ln.match(/\(([^()]*)\)\s*$/) || [])[1] || '', methods: [], strs: [] };
    out.push(cur);
    continue;
  }
  if (!cur) continue;
  if (ln.startsWith('  - ')) cur.methods.push(ln.slice(4));
  else if (ln.startsWith('      S ')) {
    const s = ln.slice(7);
    if (s.indexOf('bad-string-idx') >= 0 || s.startsWith('@type ')) continue;
    if (cur.strs.indexOf(s) < 0) cur.strs.push(s);
  }
}
for (const c of out) {
  if (re && !re.test(c.cls)) continue;
  console.log('=== ' + c.cls + '  [' + c.src + ']');
  console.log('  methods: ' + c.methods.join(', '));
  console.log('  strings: ' + c.strs.join(' ~ '));
}
