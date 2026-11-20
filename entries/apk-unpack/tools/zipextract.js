// Extract one entry from a zip (stored or deflate)
// usage: node zipextract.js <file.zip> <entryName> [outFile]
const fs = require('fs');
const zlib = require('zlib');
const buf = fs.readFileSync(process.argv[2]);
const want = process.argv[3];
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('no EOCD');
const cdCount = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
let found = null;
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const lho = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  if (name === want) { found = { method, csize, usize, lho }; break; }
  p += 46 + nameLen + extraLen + commentLen;
}
if (!found) { console.error('not found'); process.exit(1); }
const lNameLen = buf.readUInt16LE(found.lho + 26);
const lExtraLen = buf.readUInt16LE(found.lho + 28);
const dataStart = found.lho + 30 + lNameLen + lExtraLen;
const raw = buf.slice(dataStart, dataStart + found.csize);
const out = found.method === 0 ? raw : zlib.inflateRawSync(raw);
if (process.argv[4]) fs.writeFileSync(process.argv[4], out);
else console.log(out.toString('utf8'));
