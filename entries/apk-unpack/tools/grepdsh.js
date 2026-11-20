// Grep restricted to @deepseek-ai/dsh* package files only (fast: index once)
const fs = require('fs');
const path = require('path');
const dir = __dirname + '/tools/scratch/text';
const re = new RegExp(process.argv[2], 'i');
const scope = process.argv[3] || ''; // substring filter on filename
const files = fs.readdirSync(dir).filter((f) => f.startsWith('lib__node_modules__@deepseek-ai__') && f.includes(scope));
let total = 0;
let filesHit = 0;
const perFile = [];
for (const f of files) {
  const p = path.join(dir, f);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  let n = 0;
  const shown = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { n++; if (shown.length < 6) shown.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 260)}`); }
  }
  if (n > 0) { filesHit++; total += n; perFile.push([f, n, shown]); }
}
perFile.sort((a, b) => b[1] - a[1]);
for (const [f, n, shown] of perFile.slice(0, 25)) {
  console.log(`### ${f}  (${n} hits)`);
  shown.forEach((l) => console.log('   ', l));
}
console.log('TOTAL lines:', total, 'files:', filesHit, 'scanned dsh files:', files.length);
