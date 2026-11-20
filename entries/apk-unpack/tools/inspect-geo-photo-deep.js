// Deeper read of geo-photo data tables: _meta notes, entry counts, sample records.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const want = process.argv.slice(3);

function show(label, v) {
  console.log(`  ${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  if (want.length && !want.includes(f)) continue;
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  console.log(`===== ${f}`);
  if (d._meta) {
    for (const [k, v] of Object.entries(d._meta)) show(`_meta.${k}`, v);
  }
  if (f === 'admin.json') {
    console.log(`  items: array? ${Array.isArray(d.items)} length=${d.items.length}`);
    console.log('  items[0..3]:', JSON.stringify(d.items.slice(0, 4)));
    const depths = {};
    for (const it of d.items) {
      const lvl = it.level || (it.code && String(it.code).length) || '?';
      depths[lvl] = (depths[lvl] || 0) + 1;
    }
    console.log('  level histogram:', JSON.stringify(depths));
    console.log('  item keys:', Object.keys(d.items[0]).join(','));
  }
  if (f === 'area_codes.json' || f === 'plates.json') {
    const entries = Array.isArray(d.entries) ? d.entries : Object.entries(d.entries);
    console.log(`  entries: ${Array.isArray(d.entries) ? 'array' : 'object'} length=${entries.length}`);
    console.log('  entries[0..3]:', JSON.stringify(entries.slice(0, 4)));
  }
  if (f === 'calling_codes.json') {
    const ks = Object.keys(d).filter((k) => k !== '_meta');
    console.log(`  country-code keys: ${ks.length}`);
    console.log('  d["86"]:', JSON.stringify(d['86']));
    console.log('  d["81"]:', JSON.stringify(d['81']));
    console.log('  d["1"]:', JSON.stringify(d['1']));
  }
  if (f === 'country_names.json') {
    console.log(`  en2zh keys: ${Object.keys(d.en2zh).length}`);
    console.log('  sample en2zh:', JSON.stringify(Object.fromEntries(Object.entries(d.en2zh).slice(0, 5))));
    console.log(`  aliases keys: ${Object.keys(d.aliases).length}`);
    console.log('  sample aliases:', JSON.stringify(Object.fromEntries(Object.entries(d.aliases).slice(0, 5))));
  }
  if (f === 'driving_side.json') {
    const ks = Object.keys(d).filter((k) => k !== '_meta');
    console.log(`  country keys: ${ks.length}`);
    console.log('  Japan:', JSON.stringify(d['Japan']));
    console.log('  China:', JSON.stringify(d['China']));
    console.log('  United Kingdom:', JSON.stringify(d['United Kingdom']));
  }
  if (f === 'territories.json') {
    console.log('  by_sovereign type:', Array.isArray(d.by_sovereign) ? `array len=${d.by_sovereign.length}` : typeof d.by_sovereign);
    console.log('  by_sovereign[0..2]:', JSON.stringify(d.by_sovereign.slice(0, 3)));
    show('count', d.count);
    show('note', d.note);
  }
}
