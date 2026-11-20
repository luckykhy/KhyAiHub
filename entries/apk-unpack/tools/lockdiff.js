// Diff lockfile dsh entries vs installed dsh package dirs
const fs = require('fs');
const lock = JSON.parse(fs.readFileSync(__dirname + '/tools/scratch/lib__node_modules__.package-lock.json', 'utf8'));
const lockNames = Object.keys(lock.packages).filter((k) => /node_modules\/@deepseek-ai\/dsh/.test(k)).map((k) => k.replace(/^node_modules\//, ''));
const entries = fs.readFileSync(__dirname + '/tools/runtime-entries.txt', 'utf8').trim().split('\n').slice(0, -1).map((x) => x.split('\t')[3]);
const installed = new Set();
for (const n of entries) {
  const m = n.match(/^lib\/(node_modules\/(@deepseek-ai\/dsh[^/]*))\//);
  if (m) installed.add(m[2]);
}
console.log('lockfile dsh entries:', lockNames.length);
console.log('installed dsh package dirs:', installed.size);
const missing = lockNames.filter((n) => !installed.has(n));
const extra = [...installed].filter((n) => !lockNames.includes(n));
console.log('in lock but NOT installed:', missing.length ? missing.join(', ') : '(none)');
console.log('installed but NOT in lock:', extra.length ? extra.join(', ') : '(none)');
