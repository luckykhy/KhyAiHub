// Independent AXML cross-check: re-implements the chunk walker separately from
// axml.js and asserts the headline counts, so a bug in one parser can't hide a fact.
// usage: node axml-verify.js <AndroidManifest.xml>
const fs = require('fs');

const buf = fs.readFileSync(process.argv[2]);
const fail = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fail).push(msg); }

// ---- string pool, read via its own offsets (no shared code with axml.js) ----
const strCount = buf.readUInt32LE(0x10);
const flags = buf.readUInt32LE(0x18);
const stringsStart = buf.readUInt32LE(0x1c);
const utf8 = (flags & 0x100) !== 0;
const poolChunkStart = 0x08;
const poolBase = 0x24 + strCount * 4; // offsets array end (fallback when stringsStart==0)
const str = [];
for (let i = 0; i < strCount; i++) {
  const off = buf.readUInt32LE(0x24 + i * 4);
  const dataStart = stringsStart ? poolChunkStart + stringsStart : poolBase;
  let q = dataStart + off;
  if (utf8) {
    const varint = () => { let v = buf[q++]; if (v & 0x80) v = ((v & 0x7f) << 8) | buf[q++]; return v; };
    varint();
    const n = varint();
    str.push(buf.toString('utf8', q, q + n));
  } else {
    let n = buf.readUInt16LE(q); q += 2;
    if (n & 0x8000) n = ((n & 0x7fff) << 16) | buf.readUInt16LE(q), q += 2;
    str.push(buf.toString('utf16le', q, q + n * 2));
  }
}

// ---- element walk with an explicit stack, counting tag names as we go ----
let p = poolChunkStart + buf.readUInt32LE(0x0c); // next chunk after string pool
// skip resource-id chunk(s) / styles by walking chunks generically
const counts = {};
const stack = [];
let sawQueries = false;
while (p + 8 <= buf.length) {
  const type = buf.readUInt16LE(p);
  const size = buf.readUInt32LE(p + 4);
  if (size < 8) break;
  if (type === 0x0102) { // start element
    const nameIdx = buf.readUInt32LE(p + 0x14);
    const attrCount = buf.readUInt16LE(p + 0x1c);
    const name = str[nameIdx];
    counts[name] = (counts[name] || 0) + 1;
    const attrs = [];
    for (let i = 0; i < attrCount; i++) {
      const a = p + 0x24 + i * 20;
      const nsIdx = buf.readUInt32LE(a);
      const nIdx = buf.readUInt32LE(a + 4);
      const rawIdx = buf.readUInt32LE(a + 8);
      const dtype = buf[a + 15]; // Res_value inside attribute: size@12, res0@14, dataType@15, data@16
      const data = buf.readUInt32LE(a + 16);
      attrs.push({ n: str[nIdx], ns: nsIdx ? str[nsIdx] : '', raw: rawIdx >= 0 ? str[rawIdx] : null, dtype, data });
    }
    stack.push({ name, attrs });
    if (name === 'queries') sawQueries = true;
    if (process.argv[3] === '--attrs') {
      const A = attrs.map(a => {
        const pfx = a.ns === 'http://schemas.android.com/apk/res/android' ? 'android:' : '';
        let v;
        if (a.dtype === 0x03) v = 'str:' + JSON.stringify(str[a.data]);
        else if (a.dtype === 0x12) v = 'int:' + (a.data | 0) + ' (0=false,nonzero=true)';
        else if (a.dtype === 0x10) v = 'int-dec:' + (a.data | 0);
        else if (a.dtype === 0x11) v = 'int-hex:0x' + a.data.toString(16);
        else if (a.dtype === 0x01) v = 'ref:0x' + a.data.toString(16);
        else if (a.dtype === 0x02) v = 'attr:0x' + a.data.toString(16);
        else v = 't' + a.dtype.toString(16) + ':0x' + a.data.toString(16);
        return pfx + a.n + '=' + v;
      }).join(' ');
      console.log('< ' + name + (A ? ' ' + A : ''));
    }
  } else if (type === 0x0103) {
    stack.pop();
  }
  p += size;
}
check(stack.length === 0, 'element stack balanced at EOF (depth=' + stack.length + ')');

// ---- facts the ask states, re-derived from bytes ----
const q = (n) => counts[n] || 0;
check(q('activity') === 7, 'activity 数量 = 7 (实测 ' + q('activity') + ')');
check(q('service') === 4, 'service 数量 = 4 (实测 ' + q('service') + ')');
check(q('receiver') === 1, 'receiver 数量 = 1 (实测 ' + q('receiver') + ')');
check(q('uses-permission') === 14, 'uses-permission 数量 = 14 (实测 ' + q('uses-permission') + ')');
check(sawQueries, '存在 <queries> 元素');

const attrOf = (tag, attr) => {
  const hits = [];
  for (const s of stack) { void s; }
  return hits;
};
void attrOf;

// element name/attr table for the report
const lines = [];
for (const k of Object.keys(counts).sort()) lines.push(k + ' x' + counts[k]);
console.log('--- tag histogram ---\n' + lines.join('\n'));

console.log('\n--- string pool (non-empty, ' + strCount + ' entries) ---');
console.log(str.filter(s => s.length).join('\n'));

console.log('\n--- checks ---');
for (const m of ok) console.log('PASS  ' + m);
for (const m of fail) console.log('FAIL  ' + m);
process.exit(fail.length ? 1 : 0);
