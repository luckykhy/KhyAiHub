// Extract all dsh locale zh.json + en.json, dump flattened keys
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const outDir = __dirname + '/tools/scratch/locales';
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
  const nameLen = buf.readUInt16LE(p + 28);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  rows.push({ name, method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), lho: buf.readUInt32LE(p + 42) });
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
}
fs.mkdirSync(outDir, { recursive: true });
const all = {};
let n = 0;
for (const r of rows) {
  const m = r.name.match(/^(lib\/node_modules\/@deepseek-ai\/(dsh[^/]*))\/locale\/(zh|en)\.json$/);
  if (!m) continue;
  const dataStart = r.lho + 30 + buf.readUInt16LE(r.lho + 26) + buf.readUInt16LE(r.lho + 28);
  const raw = buf.slice(dataStart, dataStart + r.csize);
  const text = (r.method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
  const dest = path.join(outDir, `${m[2]}__${m[3]}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  n++;
  if (m[3] === 'zh') {
    try { all[m[2]] = JSON.parse(text); } catch (e) { all[m[2]] = { _parseError: e.message }; }
  }
}
console.log('locale files extracted:', n, '(zh parsed:', Object.keys(all).length, ')');
fs.writeFileSync(path.join(outDir, '_all-zh.json'), JSON.stringify(all, null, 1));
