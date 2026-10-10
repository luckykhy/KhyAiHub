'use strict';

/**
 * docsFastlaneContextPack.test.js — `khy docs ai-fastlane` 上下文包的落地契约(node:test)。
 *
 * 锁定的是本夜真实坏过、而此前**无任何测试引用**的三件事(`grep -rln fastlane tests/` = 0)：
 * 包体里「Mandatory Read Order」不得为空、RepoRoot 锚点必须落在真仓根、
 * 包内宣称的每条路径必须真的存在。
 * 病根是「从 __dirname 数层数」在仓库层级迁移后指到 runtime/：清单被 existsSync 过滤成 0 条，
 * 命令照旧返回成功，用户与 AI 都看不出来——形状断言([\\/]bin[\\/]khy\\.js$ 那种)同样看不见漂移，
 * 所以这里一律用磁盘存在性做判据。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildAiFastlaneContextPack } = require('../../../src/cli/handlers/docs');

const pack = buildAiFastlaneContextPack();
const repoRoot = (pack.match(/^RepoRoot: (.+)$/m) || [])[1];

function readOrderEntries() {
  const section = pack.split('## Mandatory Read Order')[1];
  if (!section) return null;
  return (section.split('\n##')[0].match(/^\d+\.\s+(.+)$/gm) || [])
    .map((l) => l.replace(/^\d+\.\s+/, '').trim());
}

test('包体带 RepoRoot，且它真的是仓根(含 AGENTS.md 与本包赖以解析的标记文件)', () => {
  assert.ok(repoRoot, `包内未打印 RepoRoot：${pack.slice(0, 200)}`);
  assert.ok(fs.existsSync(path.join(repoRoot, 'AGENTS.md')), `RepoRoot 下没有 AGENTS.md：${repoRoot}`);
  assert.ok(fs.existsSync(path.join(repoRoot, 'pyproject.toml')), `RepoRoot 下没有 pyproject.toml：${repoRoot}`);
});

test('「Mandatory Read Order」非空，且逐条路径都真实存在(空清单=锚点漂移的指纹)', () => {
  const entries = readOrderEntries();
  assert.ok(entries, '包内没有 Mandatory Read Order 小节');
  // 迁移那次这里就是 0 条：命令返回成功，但清单整节为空。
  assert.ok(entries.length > 0, '必读清单为空');
  for (const rel of entries) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `必读清单里的路径不存在：${rel}`);
  }
});

test('包内以反引号宣称的每条含斜杠路径都真实存在(导流文案不许指空)', () => {
  // 只验「含 / 的」项：`khy` 是命令名、`bugfixRegressionGate.js` 是同级文件名，都不是路径。
  const withSlash = [...new Set(
    [...pack.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((t) => t.includes('/')),
  )];
  assert.ok(withSlash.length > 0, '包内没有任何含斜杠路径，判据退化为空断言');
  for (const rel of withSlash) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    assert.ok(fs.existsSync(abs), `包内宣称的路径不存在：${rel}`);
  }
});
