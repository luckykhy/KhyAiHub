'use strict';

// 契约测试：flagRegistry 归位 D3 共享底座（P2 第 17 批，2026-09-28）。
// 锁的是「层」而不是「算法」——算法契约由 tests/services/flagRegistry.test.js（40 例）覆盖。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC_ROOT = path.join(__dirname, '..', '..');
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

function readSource(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

test('D3 真身与 services/ 壳导出同一模块对象', () => {
  const real = require('./index');
  const shell = require(path.join(SRC_ROOT, 'services', 'flagRegistry'));
  assert.strictEqual(shell, real);
  assert.strictEqual(typeof real.isFlagEnabled, 'function');
  assert.strictEqual(typeof real.resolveNumeric, 'function');
});

test('壳文件不含逻辑：只有一行 module.exports = require(...)', () => {
  const shell = readSource(path.join(SRC_ROOT, 'services', 'flagRegistry.js'));
  const code = shell.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))
    .filter((l) => l.trim() !== "'use strict';");
  assert.strictEqual(code.length, 1, `壳里出现了 ${code.length} 行代码：${code.join(' | ')}`);
  assert.match(code[0], /^module\.exports = require\('\.\.\/utils\/flagRegistry'\);$/);
});

// D3→(services|domain) 反向 require 原始站点数棘轮：只降不升。
// 本扫描口径比 check:layout 宽（含 `../services/domain/…` 这类 D2 目标与同行注释命中）：
//   第 17 批前 43 处 → 批后 35 处（−8 = flagRegistry 的 8 个 D3 消费者改指 D3 真身）。
// 守卫侧同步读数：domain-direction 58 → 50（d3-purity 46 → 38）。
const D3_REVERSE_EDGE_CEILING = 35;

test('共享底座（utils/ constants/ 直属文件）反向 require 到 services/ 处数不升', () => {
  // 只扫 src/utils 与 src/constants 的直属 .js：这正是 D3 的定义域（DOMAIN-DEPS.json D3 roots）。
  const offenders = [];
  let scanned = 0;
  for (const dir of [path.join(SRC_ROOT, 'utils'), path.join(SRC_ROOT, 'constants')]) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (!name.endsWith('.js') || !fs.statSync(abs).isFile()) continue;
      scanned += 1;
      const raw = readSource(abs);
      for (const m of raw.matchAll(REQUIRE_RE)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(abs), spec.replace(/\.js$/, ''));
        const rel = path.relative(SRC_ROOT, resolved).split(path.sep).join('/');
        if (rel.startsWith('services/')) {
          offenders.push(`${name} → ${spec}`);
        }
      }
    }
  }
  assert.ok(scanned > 100, `扫描面过小（${scanned}），此断言是空转的`);
  assert.ok(offenders.length <= D3_REVERSE_EDGE_CEILING,
    `D3→D1 反向边升到 ${offenders.length} 处（上限 ${D3_REVERSE_EDGE_CEILING}）：\n${offenders.join('\n')}`);
  assert.ok(!offenders.some((o) => o.includes('flagRegistry')),
    `flagRegistry 已归位 D3，不得再有 D3 文件从 services/ 取它：\n${offenders.join('\n')}`);
});

test('父→子门控优先级在真实登记表上仍然生效', () => {
  const { FLAGS, isFlagEnabled } = require('./index');
  const names = Object.keys(FLAGS);
  assert.ok(names.length > 50, `FLAGS 表只有 ${names.length} 条，非空断言失效`);
  const child = names.find((n) => FLAGS[n] && FLAGS[n].parent);
  assert.ok(child, '登记表里没有任何带 parent 的 flag，父子链断言失效');
  const parent = FLAGS[child].parent;
  const env = Object.create(null);
  env[parent] = '0';
  env[child] = 'true';
  assert.strictEqual(isFlagEnabled(child, env), false,
    `父门控 ${parent}=0 时子 ${child} 必须关`);
});
