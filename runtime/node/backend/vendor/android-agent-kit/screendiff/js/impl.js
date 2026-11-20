#!/usr/bin/env node
/**
 * 契约 CLI：case.json 进，ChangeSet JSON 出。
 *
 * 这是给外部实现方抄的**最小包装范例**——
 * 实现核心逻辑在 screendiff.js，这里只做「文件参数 → stdout」的适配。
 * 任何语言照这个形状包一层，就能用 tools/verify_impl.py 自测。
 *
 *   node js/impl.js /path/to/case.json
 */
'use strict';

const fs = require('fs');
const { diff } = require('./screendiff.js');

const file = process.argv[2];
if (!file) {
  process.stderr.write('用法: node impl.js <case.json>\n');
  process.exit(2);
}

let cs;
try {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  cs = diff(c.prev, c.cur);
} catch (e) {
  process.stderr.write(`解析或计算失败: ${e.message}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(cs.to_dict(), null, 1) + "\n");
