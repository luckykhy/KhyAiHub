// Extract all text-like entries from a zip into an output dir (flat with __ separators)
// usage: node extracttext.js <file.zip> <outDir> [--manifest]
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const zip = process.argv[2];
const outDir = process.argv[3];
const buf = fs.readFileSync(zip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const cdCount = buf.readUInt16LE(eocd + 10);
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
  const lho = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  rows.push({ method, csize, usize, lho, name });
  p += 46 + nameLen + extraLen + commentLen;
}
const TEXT = /\.(js|mjs|cjs|json|md|ts|d\.ts|sh|yml|yaml|txt|cfg|cnf|conf|bashrc|profile|inputrc|motd|pem|pc|info|terminfo|cmake|xml|jsonl)$/i;
let n = 0;
let bytes = 0;
fs.mkdirSync(outDir, { recursive: true });
for (const r of rows) {
  if (!TEXT.test(r.name)) continue;
  if (r.name.endsWith('/')) continue;
  const lNameLen = buf.readUInt16LE(r.lho + 26);
  const lExtraLen = buf.readUInt16LE(r.lho + 28);
  const dataStart = r.lho + 30 + lNameLen + lExtraLen;
  const raw = buf.slice(dataStart, dataStart + r.csize);
  let out;
  try {
    out = r.method === 0 ? raw : zlib.inflateRawSync(raw);
  } catch (e) {
    console.log('INFLATE-FAIL', r.name);
    continue;
  }
  // skip binary-ish content
  const head = out.slice(0, 800);
  if (head.includes(0)) { console.log('BINARY-SKIP', r.name); continue; }
  const dest = path.join(outDir, r.name.replace(/\//g, '__'));
  fs.writeFileSync(dest, out);
  n++;
  bytes += out.length;
}
console.log('extracted text files:', n, 'bytes:', bytes);
