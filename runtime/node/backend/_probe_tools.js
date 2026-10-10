'use strict';
// Temp probe: enumerate write-ish tool registrations in the tool registry.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'services', 'backend', 'src', 'tools');

const NAME_RE = /name\s*:\s*['"]([A-Za-z0-9_]+)['"]/g;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
}

const files = [];
walk(ROOT, files);

const names = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(src))) {
    const key = m[1];
    if (!names.has(key)) {
      names.set(key, []);
    }
    names.get(key).push(path.relative(path.join(__dirname, '..'), f));
  }
}

const interesting = [...names.keys()].filter((n) =>
  /write|edit|patch|replace|create|file|apply|save|str/i.test(n)
);
for (const n of interesting.sort()) {
  console.log(n, '<-', [...new Set(names.get(n))].slice(0, 2).join(', '));
}
