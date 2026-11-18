'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.join(__dirname, '..');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    // 只扫源文件：*.test.js 是同目录测试夹具，必须 import node:test，属 dev 依赖而非产物面。
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

const GUARD_LINE = "if (typeof process === 'undefined' || !process.env) return {};";

// browser-safety 扫描面（[DESIGN-ARCH-220] §14.5）：src/contracts/** + src/client/**。
// locator-host.js 是唯一允许 node: 的源文件，且不在扫描面内（§2.2）。
test('contracts+client：0 处 node:、process. 只存在于带守卫的 core-env', () => {
  const files = [...walk(path.join(pkgRoot, 'src', 'contracts')), ...walk(path.join(pkgRoot, 'src', 'client'))];
  assert.ok(files.length > 10, `扫描面应有十余个源文件，实得 ${files.length}`);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /require\(['"]node:/, `${path.relative(pkgRoot, file)} 出现 node: 内置`);
    const rel = path.relative(pkgRoot, file);
    if (rel === path.join('src', 'contracts', 'core-env.js')) {
      assert.ok(src.includes(GUARD_LINE), 'core-env.js 必须保留 typeof process 守卫（守卫式豁免的唯一形态）');
      const firstStmt = src.slice(src.indexOf('function readCoreEnv')).split('\n')[1].trim();
      assert.ok(firstStmt.startsWith('if (typeof process'), `守卫必须是函数体首条语句，实为：${firstStmt}`);
    } else {
      assert.doesNotMatch(src, /\bprocess\./, `${rel} 出现未守卫的 process. 引用`);
    }
  }
});

test('client 内 0 处 locator-host 字面量（反向边禁令；注释里的名字不算引用）', () => {
  for (const file of walk(path.join(pkgRoot, 'src', 'client'))) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      assert.doesNotMatch(lines[i], /locator-host/, `${path.relative(pkgRoot, file)}:${i + 1} 出现 locator-host 引用`);
    }
  }
});
