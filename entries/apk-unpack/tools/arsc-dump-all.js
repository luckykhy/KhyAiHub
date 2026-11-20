// Dump ALL resource entries (not just strings) from resources.arsc.
// usage: node arsc-dump-all.js <path-to-resources.arsc> [--type string,color,drawable,mipmap,style,xml]
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
let p = 0;
const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };

function readPool(start) {
  const save = p;
  p = start;
  const type = u16(), hdr = u16(), size = u32();
  const stringCount = u32(), styleCount = u32(), flags = u32(), stringsStart = u32(), stylesStart = u32();
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const offs = [];
  for (let i = 0; i < stringCount; i++) offs.push(u32());
  const dataStart = start + stringsStart;
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    let q = dataStart + offs[i];
    let s;
    if (isUtf8) {
      const readLen = () => {
        let len = buf[q]; q += 1;
        if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[q]; q += 1; }
        return len;
      };
      readLen();
      const byteLen = readLen();
      s = buf.toString('utf8', q, q + byteLen);
    } else {
      let len = buf.readUInt16LE(q); q += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q); q += 2; }
      s = buf.toString('utf16le', q, q + len * 2);
    }
    strings.push(s);
  }
  p = save;
  return strings;
}

const magic = u32();
u32();
u32();
const globalStrings = readPool(12);
const gpoolSize = buf.readUInt32LE(12 + 4);
p = 12 + gpoolSize;

const onlyTypes = process.argv.includes('--type')
  ? process.argv[process.argv.indexOf('--type') + 1].split(',')
  : null;
const results = [];

while (p + 8 <= buf.length) {
  const cStart = p;
  const cType = u16(), cHdr = u16(), cSize = u32();
  if (cSize < 8 || cStart + cSize > buf.length) break;
  if (cType === 0x0200 || cType === 0x0201) {
    const pkgId = u32();
    const nameBuf = buf.slice(p, p + 256); p += 256;
    const typeStringsOff = u32(), lastPublicType = u32(), keyStringsOff = u32(), lastPublicKey = u32();
    const typeStrings = readPool(cStart + typeStringsOff);
    const keyStrings = readPool(cStart + keyStringsOff);
    p = cStart + cHdr;
    while (p < cStart + cSize) {
      const tStart = p;
      const tType = u16(), tHdr = u16(), tSize = u32();
      if (tSize < 8 || tStart + tSize > cStart + cSize) break;
      if (tType === 0x0202) { p = tStart + tSize; continue; }
      if (tType === 0x0201) {
        const typeId = buf.readUInt8(tStart + 8);
        const entryCount = buf.readUInt32LE(tStart + 12);
        const entriesStart = buf.readUInt32LE(tStart + 16);
        for (let i = 0; i < entryCount; i++) {
          const off = buf.readUInt32LE(tStart + tHdr + i * 4);
          if (off === 0xFFFFFFFF) continue;
          const eStart = tStart + entriesStart + off;
          if (eStart + 16 > buf.length) break;
          const eSize = buf.readUInt16LE(eStart);
          const eFlags = buf.readUInt16LE(eStart + 2);
          const eKey = buf.readUInt32LE(eStart + 4);
          const key = keyStrings[eKey];
          const rid = (pkgId << 24) | (typeId << 16) | i;
          const isComplex = (eFlags & 0x0001) !== 0;
          let desc = '';
          if (isComplex) {
            const cnt = buf.readUInt32LE(eStart + 8);
            desc = 'complex(' + cnt + ')';
          } else {
            const dataType = buf.readUInt8(eStart + 11);
            const data = buf.readUInt32LE(eStart + 12);
            if (dataType === 0x03) desc = 'str:' + JSON.stringify(globalStrings[data]);
            else if (dataType === 0x01) desc = 'ref:0x' + data.toString(16);
            else if (dataType === 0x10) desc = 'hex:0x' + data.toString(16);
            else if (dataType === 0x12) desc = 'dec:' + data;
            else if (dataType === 0x11) desc = 'bool:' + (data !== 0);
            else desc = 't' + dataType.toString(16) + ':0x' + data.toString(16);
          }
          results.push({ rid, type: typeStrings[typeId - 1] || ('t' + typeId), key, desc });
        }
        p = tStart + tSize;
        continue;
      }
      p = tStart + tSize;
    }
    p = cStart + cSize;
    continue;
  }
  p = cStart + cSize;
}

const shown = onlyTypes ? results.filter(r => onlyTypes.includes(r.type)) : results;
for (const r of shown) {
  console.log(`0x${r.rid.toString(16)} ${r.type}/${r.key} = ${r.desc}`);
}
console.log('---');
console.log('shown:', shown.length, 'of total:', results.length,
  'types:', [...new Set(results.map(r => r.type))].join(','));
