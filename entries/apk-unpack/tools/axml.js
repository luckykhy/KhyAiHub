// AXML parser: binary AndroidManifest.xml -> readable tree
// usage: node axml.js <path-to-AndroidManifest.xml>
const fs = require('fs');

function readAx(buf) {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };

  const magic = u32();
  if (magic !== 0x00080003) throw new Error('not AXML, magic=' + magic.toString(16));
  u32(); // file size

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
      // AOSP UTF-8 pool entry: varint charLen, varint byteLen, bytes, NUL
      const readVarint = () => {
        let len = buf[q]; q += 1;
        if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[q]; q += 1; }
        return len;
      };
      readVarint(); // character count, not needed
      const byteLen = readVarint();
      s = buf.toString('utf8', q, q + byteLen);
    } else {
      let len = buf.readUInt16LE(q); q += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q); q += 2; }
      s = buf.toString('utf16le', q, q + len * 2);
    }
    strings.push(s);
  }
  p = spStart + spSize;

  const resIds = [];
  const out = { strings, tags: [], ns: {} };

  while (p + 8 <= buf.length) {
    const cType = u16(), cHdr = u16(), cSize = u32();
    const chunkStart = p - 8;
    if (cSize < 8) break;
    if (cType === 0x0100) { // start namespace
      const prefix = u32(), uri = u32();
      out.ns[strings[uri]] = strings[prefix];
    } else if (cType === 0x0180) { // resource ids
      const n = (cSize - 8) / 4;
      for (let i = 0; i < n; i++) resIds.push(u32());
    } else if (cType === 0x0102) { // start element
      const lineNo = u32(), comment = u32();
      const ns = u32(), name = u32();
      const attrStart = u16(), attrSize = u16(), attrCount = u16();
      const idIndex = u16(), classIndex = u16(), styleIndex = u16();
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const aNs = u32(), aName = u32(), aRaw = u32();
        const dataType = buf[p + 3];
        const data = buf.readUInt32LE(p + 4);
        p += 8;
        attrs.push({ ns: aNs, name: aName, raw: aRaw, dataType, data });
      }
      out.tags.push({ type: 'start', ns, name, attrs });
    } else if (cType === 0x0103) { // end element
      const lineNo = u32(), comment = u32();
      const ns = u32(), name = u32();
      out.tags.push({ type: 'end', ns, name });
    }
    p = chunkStart + cSize;
  }
  return out;
}

const S = readAx(fs.readFileSync(process.argv[2]));

function nsPrefix(uri) {
  if (!uri) return '';
  if (uri === 'http://schemas.android.com/apk/res/android') return 'android';
  if (uri.startsWith('http://schemas.android.com/apk/res/')) return uri.slice('http://schemas.android.com/apk/res/'.length) + ':';
  return uri + ':';
}

function fmtAttr(a) {
  const attrName = S.strings[a.name] || ('#' + a.name);
  const prefix = a.ns >= 0 ? nsPrefix(S.strings[a.ns]) : '';
  let v;
  if (a.dataType === 0x03) v = JSON.stringify(S.strings[a.data]);
  else if (a.dataType === 0x12) v = a.data + ' (dec)';
  else if (a.dataType === 0x10) v = '0x' + a.data.toString(16) + ' (hex)';
  else if (a.dataType === 0x11) v = (a.data !== 0) + ' (bool)';
  else if (a.dataType === 0x01) v = '@ref/0x' + a.data.toString(16);
  else if (a.dataType === 0x02) v = '@attr/0x' + a.data.toString(16);
  else if (a.dataType === 0x00) v = null;
  else v = `t${a.dataType.toString(16)}:0x${a.data.toString(16)}`;
  return `${prefix}${attrName}=${v}`;
}

let depth = 0;
const lines = [];
for (const t of S.tags) {
  if (t.type === 'start') {
    const name = S.strings[t.name] || ('#' + t.name);
    const prefix = t.ns >= 0 ? nsPrefix(S.strings[t.ns]) : '';
    lines.push('  '.repeat(depth) + `<${prefix}${name} ` + t.attrs.map(fmtAttr).join(' '));
    depth++;
  } else {
    depth--;
    const name = S.strings[t.name] || ('#' + t.name);
    const prefix = t.ns >= 0 ? nsPrefix(S.strings[t.ns]) : '';
    lines.push('  '.repeat(depth) + `</${prefix}${name}>`);
  }
}
console.log(lines.join('\n'));
