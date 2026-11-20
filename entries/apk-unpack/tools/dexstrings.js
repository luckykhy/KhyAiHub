// Extract printable strings from a DEX (and any binary) file
// usage: node dexstrings.js <file> <minLen>
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const minLen = parseInt(process.argv[3] || '6', 10);
const out = [];
let cur = [];
let start = 0;
for (let i = 0; i < buf.length; i++) {
  const c = buf[i];
  if (c >= 0x20 && c < 0x7f) {
    if (cur.length === 0) start = i;
    cur.push(c);
  } else {
    if (cur.length >= minLen) out.push(start + '\t' + String.fromCharCode(...cur));
    cur = [];
  }
}
if (cur.length >= minLen) out.push(start + '\t' + String.fromCharCode(...cur));
console.log(out.join('\n'));
