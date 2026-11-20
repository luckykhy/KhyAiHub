// Extract bin/node and probe its version + ELF arch
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
let found = null;
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(p + 28);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  if (name === 'bin/node') {
    found = { method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), lho: buf.readUInt32LE(p + 42) };
    break;
  }
  p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
}
const dataStart = found.lho + 30 + buf.readUInt16LE(found.lho + 26) + buf.readUInt16LE(found.lho + 28);
const raw = buf.slice(dataStart, dataStart + found.csize);
const out = found.method === 0 ? raw : zlib.inflateRawSync(raw);
console.log('bin/node uncompressed size:', out.length);
fs.writeFileSync(__dirname + '/tools/scratch/bin__node', out);
const s = out.toString('latin1');
const vers = new Set();
const re = /v(\d+\.\d+\.\d+)/g;
let m;
while ((m = re.exec(s)) !== null) vers.add(m[1]);
console.log('version-like strings (first 30):', [...vers].slice(0, 30).join(', '));
console.log('ELF magic:', out.slice(0, 4).toString('hex'), 'class(2=64bit):', out[4], 'endian:', out[5], 'machine:', out.readUInt16LE(18).toString(16), '(0x28=ARM, 0x3e=x86-64, 0xb7=aarch64)');
// node version banner is usually near 'node/' strings
const idx = s.indexOf('node v');
console.log('first "node v" occurrence context:', JSON.stringify(s.slice(idx - 40, idx + 60)));
