// Analyze runtime.zip entry listing: directory distribution, sizes, key paths
// usage: node analyze.js runtime-entries.txt
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').slice(0, -1);
const rows = lines.map((line) => {
  const t = line.split('\t');
  return { usize: +t[0], csize: +t[1], method: t[2], name: t[3] };
});
console.log('entries:', rows.length, 'uncompressed total:', rows.reduce((a, r) => a + r.usize, 0));

function top(prefixDepth) {
  const m = new Map();
  for (const r of rows) {
    const seg = r.name.split('/').slice(0, prefixDepth).join('/');
    m.set(seg, (m.get(seg) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

console.log('\n=== depth-1 ===');
top(1).forEach(([k, v]) => console.log(String(v).padStart(6), k));

console.log('\n=== depth-2 (top 40) ===');
top(2).slice(0, 40).forEach(([k, v]) => console.log(String(v).padStart(6), k));

console.log('\n=== bin/ ===');
for (const r of rows) if (r.name.startsWith('bin/')) console.log(String(r.usize).padStart(10), r.name);

console.log('\n=== lib/node_modules top-level ===');
const lm = new Map();
for (const r of rows) {
  const p = r.name.split('/');
  if (p[0] === 'lib' && p[1] === 'node_modules') {
    if (p[2] && p[2].startsWith('@')) lm.set(p.slice(2, 4).join('/'), 1);
    else if (p[2]) lm.set(p[2], 1);
  }
}
console.log('count:', lm.size);
[...lm.keys()].sort().forEach((k) => console.log(' ', k));

console.log('\n=== biggest 30 files ===');
[...rows].sort((a, b) => b.usize - a.usize).slice(0, 30).forEach((r) => console.log(String(r.usize).padStart(12), r.name));
