const fs = require('fs');
const zlib = require('zlib');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const buf = fs.readFileSync(zip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
console.log('eocd:', eocd, 'cdCount:', buf.readUInt16LE(eocd + 10), 'cdOff:', buf.readUInt32LE(eocd + 16));
const cdCount = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
let hits = 0;
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) { console.log('BAD SIG at', i, p); break; }
  const nameLen = buf.readUInt16LE(p + 28);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  const m = name.match(/^(lib\/node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*))\/package\.json$/);
  if (!m) continue;
  hits++;
  if (hits <= 5) console.log('sample m[1]:', JSON.stringify(m[1]), 'from', name);
}
console.log('total package.json matches:', hits);
