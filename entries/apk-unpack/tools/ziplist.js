// List entries of a zip file by walking the central directory
// usage: node ziplist.js <file.zip>
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
// find EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('no EOCD');
const cdCount = buf.readUInt16LE(eocd + 10);
const cdSize = buf.readUInt32LE(eocd + 12);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
const rows = [];
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  rows.push({ name, method, csize, usize });
  p += 46 + nameLen + extraLen + commentLen;
}
for (const r of rows) console.log(`${r.usize}\t${r.csize}\tm${r.method}\t${r.name}`);
console.log('entries:', rows.length, 'total uncompressed:', rows.reduce((a, r) => a + r.usize, 0));
