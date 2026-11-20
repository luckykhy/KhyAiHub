// Read-only DEX structural parser: dumps class defs, types, strings, fields, methods.
// usage: node dexmap.js <classes.dex> <mode>
//   mode: classes | types | strings | methods | fields | package <prefix>
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
const mode = process.argv[3] || 'classes';
const arg = process.argv[4] || '';

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

const stringCache = new Map();
function str(idx) {
  if (stringCache.has(idx)) return stringCache.get(idx);
  const off = u4(stringIdsOff + idx * 4);
  const [, p] = uleb(off);
  let end = p;
  while (buf[end] !== 0) end++;
  const s = buf.toString('utf8', p, end);
  stringCache.set(idx, s);
  return s;
}
const strings = [];
for (let i = 0; i < stringIdsSize; i++) strings.push(str(i));

function typeName(i) { return strings[u4(typeIdsOff + i * 4)]; }
const typeNames = [];
for (let i = 0; i < typeIdsSize; i++) typeNames.push(typeName(i));

function methodName(i) {
  const o = methodIdsOff + i * 8;
  return { cls: typeNames[u2(o)], name: strings[u4(o + 4)] };
}
function fieldName(i) {
  const o = fieldIdsOff + i * 8;
  return { cls: typeNames[u2(o)], type: typeNames[u2(o + 2)], name: strings[u4(o + 4)] };
}

if (mode === 'strings') {
  strings.forEach((s, i) => console.log(i + '\t' + s));
} else if (mode === 'types') {
  typeNames.forEach((t, i) => console.log(i + '\t' + t));
} else if (mode === 'methods') {
  const out = [];
  for (let i = 0; i < methodIdsSize; i++) {
    const m = methodName(i);
    out.push(m.cls + '->' + m.name);
  }
  console.log(out.sort().join('\n'));
} else if (mode === 'fields') {
  const out = [];
  for (let i = 0; i < fieldIdsSize; i++) {
    const f = fieldName(i);
    out.push(f.cls + '->' + f.name + ':' + f.type);
  }
  console.log(out.sort().join('\n'));
} else if (mode === 'classes' || mode === 'package') {
  const rows = [];
  for (let c = 0; c < classDefsSize; c++) {
    const o = classDefsOff + c * 32;
    const cls = typeNames[u4(o)];
    const access = u4(o + 4);
    const superIdx = u4(o + 8);
    const ifaceOff = u4(o + 12);
    const srcIdx = u4(o + 16);
    const dataOff = u4(o + 24);
    const superName = superIdx === 0xffffffff ? '' : typeNames[superIdx];
    const src = srcIdx === 0xffffffff ? '' : strings[srcIdx];
    let ifaces = [];
    if (ifaceOff !== 0) {
      const n = u4(ifaceOff);
      for (let k = 0; k < n; k++) ifaces.push(typeNames[u2(ifaceOff + 4 + k * 2)]);
    }
    // class_data_item
    let nStatic = 0, nInstance = 0, nDirect = 0, nVirtual = 0;
    if (dataOff !== 0) {
      let p = dataOff;
      [nStatic, p] = uleb(p);
      [nInstance, p] = uleb(p);
      [nDirect, p] = uleb(p);
      [nVirtual, p] = uleb(p);
    }
    const flags = [];
    if (access & 0x0001) flags.push('public');
    if (access & 0x0002) flags.push('private');
    if (access & 0x0004) flags.push('protected');
    if (access & 0x0008) flags.push('static');
    if (access & 0x0010) flags.push('final');
    if (access & 0x0200) flags.push('interface');
    if (access & 0x0400) flags.push('abstract');
    if (access & 0x1000) flags.push('synthetic');
    rows.push({
      cls, access: flags.join(','), super: superName, ifaces: ifaces.join(','),
      src, fields: nStatic + '/' + nInstance, methods: nDirect + '/' + nVirtual,
      sort: cls
    });
  }
  rows.sort((a, b) => (a.cls < b.cls ? -1 : 1));
  for (const r of rows) {
    if (mode === 'package' && arg && !r.cls.includes(arg)) continue;
    console.log([r.cls, r.access, 'super=' + r.super, r.ifaces ? 'iface=' + r.ifaces : '', 'src=' + r.src,
      'fields=' + r.fields, 'methods=' + r.methods].filter(Boolean).join('\t'));
  }
} else {
  console.error('unknown mode');
  process.exit(1);
}
