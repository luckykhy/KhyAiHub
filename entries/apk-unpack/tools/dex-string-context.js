// Dump context windows around interesting strings in classes.dex (read-only).
const fs = require('fs');
const b = fs.readFileSync(process.argv[2]);
const s = b.toString('latin1');
const keys = ['clue_lookup', 'exif_read', 'skill_load', 'ask_user', 'open_url', 'geo-photo', 'source=assets'];

for (const k of keys) {
  let i = s.indexOf(k);
  let n = 0;
  while (i >= 0 && n < 4) {
    const start = Math.max(0, i - 700);
    const end = Math.min(s.length, i + 700);
    const win = s.slice(start, end).replace(/[^\x20-\x7e\u4e00-\u9fff]/g, '.');
    console.log(`--- ${k} @${i} (occurrence ${n + 1})`);
    console.log(win);
    console.log('');
    i = s.indexOf(k, i + 1);
    n += 1;
  }
  if (n === 0) console.log(`--- ${k}: not found`);
}
