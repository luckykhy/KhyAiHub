// List all packages whose version is non-semver-standard (0.0.0-* etc.) or mentions android
const fs = require('fs');
const zlib = require('zlib');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const buf = fs.readFileSync(zip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const cdCount = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(p + 28);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const lho = buf.readUInt32LE(p + 42);
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  const m = name.match(/^(lib\/node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*))\/package\.json$/);
  if (!m) continue;
  const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const raw = buf.slice(dataStart, dataStart + csize);
  let j;
  try { j = JSON.parse((method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8')); } catch { continue; }
  const v = j.version || '';
  if (/android|inert|shim|0\.0\.0-/i.test(v) || /android|inert|shim/i.test(JSON.stringify(j.os || '') + JSON.stringify(j.cpu || ''))) {
    console.log(`${j.name}@${v}  os=${JSON.stringify(j.os)} cpu=${JSON.stringify(j.cpu)} files=${j.files ? JSON.stringify(j.files) : ''}`);
  }
}
