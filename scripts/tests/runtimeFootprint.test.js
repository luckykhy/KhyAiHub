'use strict';

// 运行时足迹探针的口径回归：**宿主预挂 ≠ 外部依赖**。
//
// 背景（2026-10-31 实测）：本机 NODE_OPTIONS 注入了 WorkBuddy 的 2 个 shim
// （32038 字节）。它们既不是第一方、也不是被测仓库的依赖，却按旧口径全部落进
// 「外部」桶 —— `khy --version`（真实外部 0 个）读成 2 个 / 32038B，
// `khy doctor`（真实 12 个 / 56088B）读成 14 个 / 88126B，
// 两条「外部依赖超基线」红灯全是宿主，仓库一行没变。
//
// 本用例用可控的假预挂复现同一形状：一个 --require 预挂文件 + 一个真外部文件，
// 断言预挂进 preloaded 桶、真外部仍进 external 桶（不能靠「全排除」刷绿）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROBE = path.join(REPO_ROOT, 'scripts', 'lib', 'runtimeFootprint.js');

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-footprint-'));
  fs.writeFileSync(path.join(dir, 'preload.js'), 'global.__khyPreloadMarker = true;\n');
  fs.writeFileSync(path.join(dir, 'external.js'), 'module.exports = 42;\n');
  return dir;
}

function runChild(dir) {
  const out = path.join(dir, 'snapshot.json');
  const env = { ...process.env, KHY_FOOTPRINT_OUT: out, KHY_FOOTPRINT_ROOT: path.join(dir, 'firstparty') };
  // NODE_OPTIONS 里的注入在本机是真实的，但用例要断言的是「预挂被单列」这一口径，
  // 保留它会让 preloadedFiles 随宿主变化；故清空，只留本用例自己的假预挂。
  delete env.NODE_OPTIONS;
  fs.mkdirSync(env.KHY_FOOTPRINT_ROOT, { recursive: true });
  const res = spawnSync(
    process.execPath,
    ['-r', path.join(dir, 'preload.js'), '-r', PROBE, '-e', `require(${JSON.stringify(path.join(dir, 'external.js'))})`],
    { env, encoding: 'utf8', cwd: dir, timeout: 60000 }
  );
  assert.strictEqual(res.status, 0, `子进程应正常退出：${res.stderr}`);
  assert.ok(fs.existsSync(out), `探针应写出快照：${res.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('--require 预挂的模块单列进 preloaded，不算外部依赖', () => {
  const dir = makeSandbox();
  try {
    const snap = runChild(dir);
    assert.strictEqual(snap.preloadedFiles, 1, `预挂应恰好 1 个，实得 ${snap.preloadedFiles}`);
    assert.strictEqual(
      snap.externalFiles,
      1,
      `真外部模块仍应计入（预挂之外只剩 external.js），实得 ${snap.externalFiles}`
    );
    assert.strictEqual(snap.firstPartyFiles, 0, '沙箱里没有第一方模块');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
