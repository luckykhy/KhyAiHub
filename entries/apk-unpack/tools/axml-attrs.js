// Dump raw AXML attributes (name, dataType, raw value) for one compiled xml file.
// usage: node axml-attrs.js <file.axml-or.xml>
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
let p = 0;
const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
const magic = u32();
if (magic !== 0x00080003) throw new Error('not AXML');
u32();
const spType = u16(), spHdr = u16(), spSize = u32();
const spStart = p - 8;
const stringCount = u32(), styleCount = u32(), flags = u32();
const stringsStart = u32(), stylesStart = u32();
const isUtf8 = (flags & (1 << 8)) !== 0;
const strOffsets = [];
for (let i = 0; i < stringCount; i++) strOffsets.push(u32());
const strDataStart = spStart + stringsStart;
const strings = [];
for (let i = 0; i < stringCount; i++) {
  let q = strDataStart + strOffsets[i];
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
p = spStart + spSize;
const TYPE = { 0x00: 'NULL', 0x01: 'REFERENCE', 0x02: 'ATTRIBUTE', 0x03: 'STRING', 0x04: 'FLOAT', 0x05: 'DIMENSION', 0x06: 'FRACTION', 0x10: 'INT_DEC', 0x11: 'INT_HEX', 0x12: 'INT_BOOLEAN', 0x1c: 'INT_COLOR_ARGB8', 0x1d: 'INT_COLOR_RGB8' };
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
while (p + 8 <= buf.length) {
  const cType = u16(), cHdr = u16(), cSize = u32();
  const chunkStart = p - 8;
  if (cSize < 8) break;
  if (cType === 0x0100) { u32(); u32(); }
  else if (cType === 0x0180) { const n = (cSize - 8) / 4; for (let i = 0; i < n; i++) u32(); }
  else if (cType === 0x0102) {
    u32(); u32();
    const ns = u32(), name = u32();
    const attrStart = u16(), attrSize = u16(), attrCount = u16();
    u16(); u16(); u16();
    const el = strings[name];
    console.log('ELEMENT <' + el + '>');
    for (let i = 0; i < attrCount; i++) {
      const aNs = u32(), aName = u32(), aRaw = u32();
      const dataType = buf[p + 3];
      const data = buf.readUInt32LE(p + 4);
      p += 8;
      const attr = strings[aName];
      const prefix = aNs >= 0 && strings[aNs] === ANDROID_NS ? 'android:' : (aNs >= 0 ? strings[aNs] + ':' : '');
      let shown;
      if (dataType === 0x12) shown = (data !== 0) + ' (raw 0x' + data.toString(16) + ')';
      else if (dataType === 0x03) shown = JSON.stringify(strings[data]);
      else if (dataType === 0x01) shown = '@0x' + data.toString(16);
      else shown = '0x' + data.toString(16) + ' (' + data + ')';
      console.log('  ' + prefix + attr + ' : ' + (TYPE[dataType] || ('t' + dataType.toString(16))) + ' = ' + shown);
    }
  } else if (cType === 0x0103) { u32(); u32(); u32(); u32(); }
  p = chunkStart + cSize;
}
