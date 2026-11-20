// Static inspector for the geo-photo skill data tables (read-only, no network).
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

for (const f of files) {
  const full = path.join(dir, f);
  const raw = fs.readFileSync(full, 'utf8');
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    console.log(`=== ${f}: JSON PARSE ERROR ${e.message}`);
    continue;
  }
  console.log(`=== ${f} (${raw.length} chars)`);
  if (Array.isArray(d)) {
    console.log(`  array, length=${d.length}`);
    console.log('  first:', JSON.stringify(d[0]).slice(0, 400));
    console.log('  last :', JSON.stringify(d[d.length - 1]).slice(0, 400));
  } else {
    const keys = Object.keys(d);
    console.log(`  object, keys=${keys.length}`);
    console.log('  first 8 keys:', keys.slice(0, 8).join(' | '));
    console.log('  sample value:', JSON.stringify(d[keys[0]]).slice(0, 400));
  }
}
