// Extract selected entries; args: <entry> [<entry>...] -- prefix from file list
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const outDir = __dirname + '/tools/scratch/x';
const wants = process.argv.slice(2);
const buf = fs.readFileSync(zip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const cdCount = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
const index = new Map();
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(p + 28);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  index.set(name, { method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), lho: buf.readUInt32LE(p + 42) });
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
}
fs.mkdirSync(outDir, { recursive: true });
for (const want of wants) {
  const e = index.get(want);
  if (!e) { console.log('MISS', want); continue; }
  const lNameLen = buf.readUInt16LE(e.lho + 26);
  const lExtraLen = buf.readUInt16LE(e.lho + 28);
  const dataStart = e.lho + 30 + lNameLen + lExtraLen;
  const raw = buf.slice(dataStart, dataStart + e.csize);
  const out = e.method === 0 ? raw : zlib.inflateRawSync(raw);
  const dest = path.join(outDir, want.replace(/\//g, '__'));
  fs.writeFileSync(dest, out);
  console.log('OK', want, out.length);
}
