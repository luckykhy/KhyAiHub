'use strict';
const fs = require('fs');
const path = require('path');
const dir = 'src/cli/tui';
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      const src = fs.readFileSync(p, 'utf8');
      src.split(/\r?\n/).forEach((l, i) => {
        if (/useQueryBridge|compaction/.test(l) && !/CompactionProgress\.js$/.test(p)) {
          console.log(p.replace(/\\/g, '/') + ':' + (i + 1) + ': ' + l.trim().slice(0, 120));
        }
      });
    }
  }
}
walk(dir);
