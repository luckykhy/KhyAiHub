// Extract all @deepseek-ai/dsh* package.json files, then summarize name/version/description/bin/exports
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const zip = __dirname + '/../hiao2/assets/engine/runtime.zip';
const outDir = __dirname + '/tools/scratch/dsh-pkg';
const buf = fs.readFileSync(zip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
const cdCount = buf.readUInt16LE(eocd + 10);
const cdOff = buf.readUInt32LE(eocd + 16);
let p = cdOff;
fs.mkdirSync(outDir, { recursive: true });
const out = [];
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const lho = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  p += 46 + nameLen + extraLen + commentLen;
  const m = name.match(/^(lib\/node_modules\/@deepseek-ai\/dsh[^/]*)\/package\.json$/);
  if (!m) continue;
  const lNameLen = buf.readUInt16LE(lho + 26);
  const lExtraLen = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + lNameLen + lExtraLen;
  const raw = buf.slice(dataStart, dataStart + csize);
  const text = (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
  try {
    const j = JSON.parse(text);
    out.push({
      name: j.name,
      version: j.version,
      description: j.description || '',
      bin: j.bin ? Object.keys(j.bin) : [],
      type: j.type || '',
      deps: j.dependencies ? Object.keys(j.dependencies).length : 0,
      files: j.files || [],
    });
  } catch (e) {
    out.push({ name: m[1], version: 'PARSE-FAIL', description: text.slice(0, 100) });
  }
}
out.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(outDir, 'dsh-packages.json'), JSON.stringify(out, null, 1));
console.log('dsh packages:', out.length);
const versions = {};
for (const o of out) versions[o.version] = (versions[o.version] || 0) + 1;
console.log('version histogram:', JSON.stringify(versions));
for (const o of out) console.log(`${o.name}  [${o.version}]  ${o.description}`);
