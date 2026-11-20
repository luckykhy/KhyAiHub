// Read-only DEX bytecode scanner: for each class/method, list referenced
// string literals, method calls and field accesses.
// usage: node dexcode.js <classes.dex> <ClassDescriptorFilterRegex> [--full]
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
const full = process.argv.includes('--full');

const u4 = (o) => buf.readUInt32LE(o);
const u2 = (o) => buf.readUInt16LE(o);

const stringIdsSize = u4(0x38), stringIdsOff = u4(0x3c);
const typeIdsSize = u4(0x40), typeIdsOff = u4(0x44);
const fieldIdsSize = u4(0x50), fieldIdsOff = u4(0x54);
const methodIdsSize = u4(0x58), methodIdsOff = u4(0x5c);
const classDefsSize = u4(0x60), classDefsOff = u4(0x64);

function uleb(o) {
  let r = 0, s = 0, i = o;
  for (;;) {
    const b = buf[i++];
    r |= (b & 0x7f) << s;
    if ((b & 0x80) === 0) break;
    s += 7;
  }
  return [r, i];
}
const strCache = new Map();
function str(idx) {
  if (idx < 0 || idx >= stringIdsSize) return '<bad-string-idx ' + idx + '>';
  if (strCache.has(idx)) return strCache.get(idx);
  const off = u4(stringIdsOff + idx * 4);
  const [, p] = uleb(off);
  let end = p;
  while (buf[end] !== 0) end++;
  const s = buf.toString('utf8', p, end);
  strCache.set(idx, s);
  return s;
}
const typeNames = [];
for (let i = 0; i < typeIdsSize; i++) typeNames.push(str(u4(typeIdsOff + i * 4)));
const mName = (i) => str(u4(methodIdsOff + i * 8 + 4));
const mCls = (i) => typeNames[u2(methodIdsOff + i * 8)];
const fName = (i) => str(u4(fieldIdsOff + i * 8 + 4));
const fCls = (i) => typeNames[u2(fieldIdsOff + i * 8)];

// opcode -> instruction size in 16-bit code units
const SIZE = {};
(function () {
  const rows = [
    ['00', 1], ['01', 1], ['02', 2], ['03', 3], ['04', 1], ['05', 2], ['06', 3],
    ['07', 1], ['08', 2], ['09', 3], ['0a', 1], ['0b', 1], ['0c', 1], ['0d', 1],
    ['0e', 1], ['0f', 1], ['10', 1], ['11', 1], ['12', 1], ['13', 2], ['14', 3],
    ['15', 2], ['16', 2], ['17', 3], ['18', 5], ['19', 2], ['1a', 2], ['1b', 3],
    ['1c', 2], ['1d', 1], ['1e', 1], ['1f', 2], ['20', 2], ['21', 1], ['22', 2],
    ['23', 2], ['24', 3], ['25', 3], ['26', 3], ['27', 1], ['28', 1], ['29', 2],
    ['2a', 3], ['2b', 3], ['2c', 3], ['2d', 2], ['2e', 2], ['2f', 2], ['30', 2],
    ['31', 2], ['32', 2], ['33', 2], ['34', 2], ['35', 2], ['36', 2], ['37', 2],
    ['38', 2], ['39', 2], ['3a', 2], ['3b', 2], ['3c', 2], ['3d', 2], ['3e', 2],
    ['44', 2], ['45', 2], ['46', 2], ['47', 2], ['48', 2], ['49', 2], ['4a', 2],
    ['4b', 2], ['4c', 2], ['4d', 2], ['4e', 2], ['4f', 2], ['50', 2], ['51', 2],
    ['52', 2], ['53', 2], ['54', 2], ['55', 2], ['56', 2], ['57', 2], ['58', 2],
    ['59', 2], ['5a', 2], ['5b', 2], ['5c', 2], ['5d', 2], ['5e', 2], ['5f', 2],
    ['60', 2], ['61', 2], ['62', 2], ['63', 2], ['64', 2], ['65', 2], ['66', 2],
    ['67', 2], ['68', 2], ['69', 2], ['6a', 2], ['6b', 2], ['6c', 2], ['6d', 2],
    ['6e', 3], ['6f', 3], ['70', 3], ['71', 3], ['72', 3], ['74', 3], ['75', 3],
    ['76', 3], ['77', 3], ['78', 3], ['7b', 1], ['7c', 1], ['7d', 1], ['7e', 1],
    ['7f', 1], ['80', 1], ['81', 1], ['82', 1], ['83', 1], ['84', 1], ['85', 1],
    ['86', 1], ['87', 1], ['88', 1], ['89', 1], ['8a', 1], ['8b', 1], ['8c', 1],
    ['8d', 1], ['8e', 1], ['8f', 1], ['90', 2], ['91', 2], ['92', 2], ['93', 2],
    ['94', 2], ['95', 2], ['96', 2], ['97', 2], ['98', 2], ['99', 2], ['9a', 2],
    ['9b', 2], ['9c', 2], ['9d', 2], ['9e', 2], ['9f', 2], ['a0', 2], ['a1', 2],
    ['a2', 2], ['a3', 2], ['a4', 2], ['a5', 2], ['a6', 2], ['a7', 2], ['a8', 2],
    ['a9', 2], ['aa', 2], ['ab', 2], ['ac', 2],
    ['d0', 2], ['d1', 2], ['d2', 2], ['d3', 2], ['d4', 2], ['d5', 2], ['d6', 2],
    ['d7', 2], ['d8', 2], ['d9', 2], ['da', 2], ['db', 2], ['dc', 2], ['dd', 2],
    ['de', 2], ['df', 2], ['e0', 2], ['e1', 2], ['e2', 2]
  ];
  for (const [k, v] of rows) SIZE[parseInt(k, 16)] = v;
})();
const sizeOf = (op) => (SIZE[op] || 1);

// pseudo-opcode payloads (ident word 0x0100/0x0200/0x0300) must be skipped whole
function payloadUnits(buf, i) {
  const unit = buf.readUInt16LE(i);
  if (unit === 0x0100) return 4 + buf.readUInt16LE(i + 2) * 2;       // packed-switch
  if (unit === 0x0200) return 2 + buf.readUInt16LE(i + 2) * 4;       // sparse-switch
  if (unit === 0x0300) {                                              // array-data
    const w = buf.readUInt16LE(i + 2);
    const n = buf.readUInt32LE(i + 4);
    return 4 + Math.ceil((n * w) / 2);
  }
  return 0;
}

function walkMethods(dataOff, cb) {
  if (!dataOff) return;
  let p = dataOff;
  const [nStatic, p1] = uleb(p); const [nInstance, p2] = uleb(p1);
  const [nDirect, p3] = uleb(p2); const [nVirtual, p4] = uleb(p3);
  let pos = p4;
  // skip encoded_field list (static + instance) — not methods
  for (let k = 0; k < nStatic + nInstance; k++) {
    const [diff, q] = uleb(pos);
    const [, r] = uleb(q);
    pos = r;
  }
  let idx = 0;
  for (let k = 0; k < nDirect + nVirtual; k++) {
    const [diff, q] = uleb(pos); idx += diff;
    const [acc, r] = uleb(q);
    const [codeOff, s] = uleb(r);
    if (idx >= 0 && idx < methodIdsSize) cb(idx, acc, codeOff);
    pos = s;
  }
}

for (let c = 0; c < classDefsSize; c++) {
  const o = classDefsOff + c * 32;
  const cls = typeNames[u4(o)];
  if (filter && !filter.test(cls)) continue;
  const srcIdx = u4(o + 16);
  const src = srcIdx === 0xffffffff ? '' : str(srcIdx);
  const dataOff = u4(o + 24);
  console.log('### ' + cls + '  (' + src + ')');
  const seen = new Set();
  walkMethods(dataOff, (mIdx, acc, codeOff) => {
    if (seen.has(mIdx)) return;
    seen.add(mIdx);
    const name = mName(mIdx);
    const strings = [], calls = [], fields = [];
    if (codeOff) {
      const insnsSize = u4(codeOff + 12);
      const start = codeOff + 16;
      const end = start + insnsSize * 2;
      let i = start;
      while (i < end) {
        const op = buf[i];
        const pl = payloadUnits(buf, i);
        if (pl > 0) { i += pl * 2; continue; }
        if (op === 0x1a) strings.push(str(u2(i + 2)));
        else if (op === 0x1b) strings.push(str(u4(i + 2)));
        else if ([0x1c, 0x1f, 0x20, 0x22, 0x23, 0x24, 0x25].includes(op)) {
          const t = u2(i + 2);
          if (t < typeNames.length) strings.push('@type ' + typeNames[t]);
        } else if (op >= 0x52 && op <= 0x6d) {
          const f = u2(i + 2);
          if (f < fieldIdsSize) fields.push(fCls(f) + '->' + fName(f));
        } else if (op >= 0x60 && op <= 0x78) {
          const m = u2(i + 2);
          if (m < methodIdsSize) calls.push(mCls(m) + '->' + mName(m));
        }
        i += sizeOf(op) * 2;
      }
    }
    console.log('  - ' + name + (codeOff ? '' : '   [abstract/native]'));
    if (full) {
      for (const s of strings) console.log('      S ' + s);
      for (const x of calls) console.log('      C ' + x);
      for (const x of fields) console.log('      F ' + x);
    } else {
      for (const s of [...new Set(strings)]) console.log('      S ' + s);
    }
  });
}
