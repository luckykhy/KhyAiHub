// Search the built frontend dist for Chinese UI strings
const fs = require('fs');
const path = require('path');
const dir = __dirname + '/tools/scratch/text';
const files = fs.readdirSync(dir).filter((f) => f.startsWith('lib__node_modules__@deepseek-ai__dsh-web-frontend__dist__assets__'));
const zh = /[\u4e00-\u9fa5]{2,}/g;
const found = new Map();
for (const f of files) {
  if (!/\.(js|css|html)$/.test(f)) continue;
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  let m;
  const local = new Set();
  while ((m = zh.exec(t)) !== null) {
    const s = m[0];
    // keep only plausible UI phrases (2-12 chars), skip css garbage
    if (s.length >= 2 && s.length <= 14) local.add(s);
  }
  for (const s of local) found.set(s, (found.get(s) || 0) + 1);
}
const arr = [...found.entries()].sort((a, b) => b[1] - a[1]);
console.log('distinct Chinese strings:', arr.length);
for (const [s, n] of arr.slice(0, 400)) console.log(String(n).padStart(3), s);
