// Inspect the raw code points of one string entry in resources.arsc global pool.
// usage: node arsc-string-codepoints.js <resources.arsc> <substring>
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const needle = process.argv[3];
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
      const rv = () => { let len = buf[q]; q += 1; if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[q]; q += 1; } return len; };
      rv();
      const byteLen = rv();
      s = buf.toString('utf8', q, q + byteLen);
    } else {
      let len = buf.readUInt16LE(q); q += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q); q += 2; }
      s = buf.toString('utf16le', q, q + len * 2);
    }
    strings.push(s);
  }
  p = save;
  return { strings, isUtf8 };
}
const magic = u32(); u32(); u32();
const gs = readPool(12);
const idx = gs.strings.findIndex(s => s.includes(needle));
console.log('utf8 pool:', gs.isUtf8, 'idx:', idx);
const s = gs.strings[idx];
console.log('json:', JSON.stringify(s));
console.log('codepoints:', [...s].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' '));
