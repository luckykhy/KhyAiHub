#!/usr/bin/env node
/**
 * 契约 CLI：XML 文件路径进，结构化 JSON 出。
 *
 * 这个文件是给外部实现方抄的**最小包装范例**——
 * 实现核心逻辑在 uidref.js，这里只做「文件参数 → stdout」的适配。
 * 任何语言照这个形状包一层，就能用 tools/verify_impl.py 自测。
 *
 *   node js/impl.js /path/to/input.xml
 */
'use strict';

const fs = require('fs');
const { parse } = require('./uidref.js');

const file = process.argv[2];
if (!file) {
  process.stderr.write('用法: node impl.js <input.xml>\n');
  process.exit(2);
}

let s;
try {
  s = parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  process.stderr.write(`解析失败: ${e.message}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  package: s.package,
  rotation: s.rotation,
  elements: s.elements.map((e) => ({
    ref: e.ref,
    role: e.role,
    label: e.label,
    bounds: e.bounds,
    center: e.center,
    center: e.center,
    clickable: e.clickable,
    long_clickable: e.long_clickable,
    scrollable: e.scrollable,
    editable: e.editable,
    checked: e.checked,
    disabled: e.disabled,
    password: e.password,
  })),
}, null, 1) + "\n");
