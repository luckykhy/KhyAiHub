'use strict';

/**
 * 批次 18 契约测试 —— D4 交付面取运行时能力必须直指 D2 真身，不得借道 D5 兼容壳。
 *
 * 背景：scripts/lib/{hydrationHealth,installIntegrity}.js 是 3 行纯 re-export 壳，
 * 真身在 runtime/node/backend/src/services/domain/backup/restore/。壳的存在只服务于
 * D5 本地脚本（scripts/restore/**、scripts/tests/**）——D5 可以依赖一切域，所以合法。
 * 但 delivery/extension/**（D4）require 这两个壳，就构成「交付面伸进工程档案区」的禁止边
 * （DOMAIN-DEPS.json no-reach-into-archive）。
 *
 * check:layout 只数边的总数，不锁「某个壳的消费者范围」这一方向；本测试锁住它，
 * 防止后续改动把 require 路径改回壳、把已摘掉的 3 条禁止边重新长回来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const TRUTH_DIR = 'runtime/node/backend/src/services/domain/backup/restore';
const SHELLS = ['scripts/lib/hydrationHealth.js', 'scripts/lib/installIntegrity.js'];

function gitGrepFiles(fixedPatterns) {
  const args = ['grep', '--untracked', '-l', '-I', '-F'];
  for (const p of fixedPatterns) args.push('-e', p);
  args.push('--', '*.js');
  let out;
  try {
    out = cp.execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // git grep 无命中时退出码为 1，这才是「零命中」；其它失败必须显式报错，
    // 否则仪器坏了会静默给出一个「全绿」的假安全结论。
    if (err && err.status === 1) return [];
    throw err;
  }
  return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}

test('壳的消费者只在 D5（scripts/）内，交付面一律直指真身', () => {
  // 只匹配 require 说明符尾部，注释里提到壳路径不算边。
  // 模式必须拼装而成：本文件若直接写出该字面量，扫描会命中自己。
  const SHELL_MODS = ['hydrationHealth', 'installIntegrity'];
  const hits = gitGrepFiles(SHELL_MODS.map((m) => `lib/${m}` + `')`));
  // 精确等值：既防「禁止边回潮」（多出交付面消费者），
  // 也防「扫描失效导致空集假绿」（少掉已知 D5 消费者）。
  assert.deepStrictEqual(
    hits,
    [
      'scripts/restore/restore-plan.js',
      'scripts/tests/hydrationHealth.test.js',
      'scripts/tests/installIntegrity.test.js',
    ].sort(),
    `壳的消费者集合变了：${hits.join(', ')}`
  );
});

test('两个 extensions 脚本的 require 指向 D2 真身而非 D5 壳', () => {
  const cases = [
    ['delivery/extension/scripts/khy-diagnostics/hydration-doctor.js', 'hydrationHealth'],
    ['delivery/extension/scripts/khy-installer/verify-install.js', 'installIntegrity'],
  ];
  for (const [rel, mod] of cases) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      src.includes(`require('../../../${TRUTH_DIR}/${mod}')`),
      `${rel} 未指向 ${TRUTH_DIR}/${mod}`
    );
    assert.ok(
      !src.includes(`scripts/lib/${mod}`),
      `${rel} 仍残留 D5 壳路径 scripts/lib/${mod}`
    );
  }
});

test('真身导出消费者实际用到的符号（改指后不得指向空模块）', () => {
  const hydration = require(path.join(ROOT, TRUTH_DIR, 'hydrationHealth.js'));
  for (const k of ['assessHydrationHealth', '_RULES', 'CRITICAL_PACKAGES', '_PACKAGE_HINTS']) {
    assert.ok(k in hydration, `hydrationHealth 缺 ${k}`);
  }
  assert.strictEqual(typeof hydration.assessHydrationHealth, 'function');

  const integrity = require(path.join(ROOT, TRUTH_DIR, 'installIntegrity.js'));
  for (const k of ['assessInstallIntegrity', 'CRITICAL_BUNDLE_PATHS', '_PATH_HINTS']) {
    assert.ok(k in integrity, `installIntegrity 缺 ${k}`);
  }
  assert.strictEqual(typeof integrity.assessInstallIntegrity, 'function');
  // 关键路径表必须非空，否则「改指后壳还在但真身被掏空」这类事故测不出来。
  assert.ok(integrity.CRITICAL_BUNDLE_PATHS.length > 0, 'CRITICAL_BUNDLE_PATHS 为空');
});

test('壳仍是纯 re-export，且与真身同一对象', () => {
  for (const shell of SHELLS) {
    const src = fs.readFileSync(path.join(ROOT, shell), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && l !== "'use strict';");
    assert.strictEqual(code.length, 1, `${shell} 不是单语句壳：${code.join(' | ')}`);
  }
  const shellHy = require(path.join(ROOT, 'scripts/lib/hydrationHealth.js'));
  const truthHy = require(path.join(ROOT, TRUTH_DIR, 'hydrationHealth.js'));
  assert.strictEqual(shellHy, truthHy, '壳与真身不是同一模块实例（存在两份实现）');
});
