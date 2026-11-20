// Grep the extracted text tree. usage: node grep.js <dir> <regex> [--files] [--count]
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const re = new RegExp(process.argv[3], 'i');
const filesOnly = process.argv.includes('--files');
const countOnly = process.argv.includes('--count');
const maxPerFile = process.argv.includes('--all') ? 1e9 : 5;
let total = 0;
const fileHits = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      let shown = 0;
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          n++;
          total++;
          if (!filesOnly && !countOnly && shown < maxPerFile) {
            console.log(`${p}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            shown++;
          }
        }
      }
      if (n > 0) fileHits.push([p, n]);
    }
  }
}
walk(dir);
if (countOnly) {
  fileHits.sort((a, b) => b[1] - a[1]);
  console.log('--- files with hits (count desc) ---');
  fileHits.slice(0, 60).forEach(([p, n]) => console.log(String(n).padStart(5), p));
}
console.log('TOTAL matching lines:', total, 'files:', fileHits.length);
