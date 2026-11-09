#!/usr/bin/env node
/**
 * gen-atomic-capabilities.js — 生成原子能力注册表（机读）。
 *
 * 用法：
 *   node scripts/ci/gen-atomic-capabilities.js          # 写入注册表
 *   node scripts/ci/gen-atomic-capabilities.js --check  # 只校验是否最新（CI 用，漂移即退出码 1）
 *
 * WHY 生成而不是手维护：原子能力散布在 6 个暴露面、336 个工具名里。
 * 手维护的清单必然漂移，而漂移的清单比没有清单更危险——它会让
 * 「我查过登记表，没有重复」变成一句假话。所以：
 *   - 人工只维护 `scripts/lib/atomicCapabilityRegistry.js` 的 ATOMIC_GROUPS（能力语义）；
 *   - 工具名的进出、canonical 的定位由本脚本从**代码实测**得出。
 *
 * 守卫 `scripts/ci/check-atomic-capabilities.js` 消费本脚本的产物。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { buildRegistryDocument } = require('../lib/atomicCapabilityRegistry');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_REL = 'docs/10_规范/registry/ATOMIC-CAPABILITIES.json';

/**
 * 序列化为稳定格式（2 空格缩进 + 末尾换行）。
 * @param {object} doc
 * @returns {string}
 */
function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const doc = buildRegistryDocument();
  const text = serialize(doc);
  const abs = path.join(REPO_ROOT, OUT_REL);

  if (checkOnly) {
    let current = null;
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch {
      current = null;
    }
    if (current === null) {
      console.log(`[ERROR] atomic-registry-missing ${OUT_REL}:1`);
      console.log('  注册表不存在。请运行：node scripts/ci/gen-atomic-capabilities.js');
      process.exitCode = 1;
      return;
    }
    if (current !== text) {
      console.log(`[ERROR] atomic-registry-stale ${OUT_REL}:1`);
      console.log('  注册表与当前代码不一致（新增/移除工具，或能力分组变动）。');
      console.log('  请运行：node scripts/ci/gen-atomic-capabilities.js');
      process.exitCode = 1;
      return;
    }
    console.log('gen-atomic-capabilities: 注册表与代码一致。');
    return;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  console.log(`gen-atomic-capabilities: 已写入 ${OUT_REL}`);
  console.log(`  原子能力 ${doc.capabilities.length} 个 · 暴露名 ${doc.coverage.totalExposed} 个`
    + ` · 孤儿 ${doc.coverage.totalOrphans} 个`);
}

main();
