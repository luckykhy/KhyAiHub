#!/usr/bin/env node
/** 把 uiautomator XML 转成与 Python 侧完全同构的 JSON，供跨语言差分比对。 */
'use strict';
const fs = require('fs');
const { parse } = require('./uidref.js');
const out = {};
for (const f of process.argv.slice(2)) {
  const s = parse(fs.readFileSync(f, 'utf8'));
  out[f] = {
    package: s.package, rotation: s.rotation,
    elements: s.elements.map((e) => ({
      ref: e.ref, role: e.role, label: e.label,
      bounds: [e.bounds[0], e.bounds[1], e.bounds[2], e.bounds[3]],
      center: e.center,
      clickable: e.clickable, long_clickable: e.long_clickable,
      scrollable: e.scrollable, editable: e.editable, checked: e.checked,
      disabled: e.disabled, password: e.password,
    })),
  };
}
process.stdout.write(JSON.stringify(out, null, 1));
