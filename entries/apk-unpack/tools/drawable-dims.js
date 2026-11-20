// Decode AXML vector/shape drawables: viewport, dimension attrs (dip/sp/px), colors, path count.
// usage: node drawable-dims.js <res-dir>
const fs = require('fs');
const path = require('path');

function readAx(buf) {
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
  const out = { strings, tags: [] };
  while (p + 8 <= buf.length) {
    const cType = u16(), cHdr = u16(), cSize = u32();
    const chunkStart = p - 8;
    if (cSize < 8) break;
    if (cType === 0x0102) {
      u32(); u32();
      const ns = u32(), name = u32();
      const attrStart = u16(), attrSize = u16(), attrCount = u16();
      u16(); u16(); u16();
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const aNs = u32(), aName = u32(), aRaw = u32();
        const dataType = buf[p + 3];
        const data = buf.readUInt32LE(p + 4);
        p += 8;
        attrs.push({ ns: aNs, name: aName, raw: aRaw, dataType, data });
      }
      out.tags.push({ type: 'start', ns, name, attrs });
    } else if (cType === 0x0103) {
      u32(); u32(); u32(); u32();
      out.tags.push({ type: 'end' });
    } else if (cType === 0x0100) {
      u32(); u32();
    } else if (cType === 0x0180) {
      const n = (cSize - 8) / 4;
      for (let i = 0; i < n; i++) u32();
    }
    p = chunkStart + cSize;
  }
  return out;
}

const UNITS = ['px', 'dip', 'sp', 'pt', 'in', 'mm'];
const dir = process.argv[2];
for (const sub of ['drawable', 'mipmap-anydpi-v26']) {
  const full = path.join(dir, sub);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) {
    const S = readAx(fs.readFileSync(path.join(full, f)));
    const dims = {}, colors = [];
    let vp = '', paths = 0, tag0 = '';
    for (const t of S.tags) {
      if (t.type !== 'start') continue;
      const tagName = S.strings[t.name] || '';
      if (!tag0) tag0 = tagName;
      if (tagName === 'path') paths++;
      for (const a of t.attrs) {
        const n = S.strings[a.name] || '';
        if (a.dataType === 0x05) {
          const unit = a.data & 0xf, radix = (a.data >> 4) & 0x3, mant = a.data >> 8;
          dims[n] = (radix === 0 ? String(mant) : 'radix' + radix + ':' + mant) + (UNITS[unit] || unit);
        } else if (a.dataType === 0x04) {
          vp += n + '=' + Buffer.from(new Uint32Array([a.data]).buffer).readFloatLE(0).toFixed(1) + ' ';
        } else if (a.dataType === 0x1c || a.dataType === 0x1d) {
          colors.push('#' + a.data.toString(16).padStart(8, '0'));
        }
      }
    }
    console.log(f.padEnd(28), '<' + tag0 + '>', vp.trim(), JSON.stringify(dims), 'paths=' + paths, 'colors=' + [...new Set(colors)].join(','));
  }
}
