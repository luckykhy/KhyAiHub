'use strict';
// 契约:KHY_MD_TOOLS_DIR 设了但无效时,resolveDir 必须【在 stderr 一次性警告】后回退,
// 而不得静默吞掉(轮十九,ledger [51];真实事故:静默回退导致误判分支可达,
// `khy md register` 真实执行并写 HKCU 注册表)。stdout 通道逐字节不变(管道/JSON 纯度)。
// 叶子直调口径(同 handlers/md.js:50 的调用),真 CLI 入口会启动 GUI/写注册表,不复现于子命令。
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(BE, '..', '..');
const MOD = path.join(BE, 'src/services/domain/extensions/extensions/markdownWorkbench.js');
const VALID = path.join(ROOT, 'extensions/tools/khy-markdown');

const CHILD = `
  const times = Number(process.argv[1]) || 1;
  const { resolveDir } = require(${JSON.stringify(MOD)});
  for (let i = 0; i < times; i++) process.stdout.write('resolved=' + String(resolveDir()) + '\\n');
`;

function runChild(env, times = 1) {
  const e = { ...process.env };
  if (env === undefined) delete e.KHY_MD_TOOLS_DIR;
  else e.KHY_MD_TOOLS_DIR = env;
  return spawnSync(process.execPath, ['-e', CHILD, String(times)], {
    env: e, encoding: 'utf8', timeout: 30000,
  });
}

test('无效覆盖:stderr 给出「问题+现状+动作」三要素,stdout 仍是契约回退目录', () => {
  const r = runChild('D:/definitely-not-here');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /KHY_MD_TOOLS_DIR/, '警告须点名变量');
  assert.match(r.stderr, /khyos-md-bridge\.js/, '须说明缺什么(问题)');
  assert.match(r.stderr, /D:\/definitely-not-here/, '须回显实际值');
  assert.match(r.stderr, /忽略/, '须说明已忽略并回退(现状)');
  assert.match(r.stderr, /修正|取消/, '须给修复动作');
  assert.doesNotMatch(r.stdout, /definitely-not-here/, 'stdout 不得出现无效值');
  assert.match(r.stdout, new RegExp(`resolved=`), 'stdout 应有解析结果');
});

test('对照:未设覆盖 → 双通道安静,行为不变', () => {
  const r = runChild(undefined);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr.trim(), '', '未设变量不得报警告');
});

test('对照:有效覆盖 → 双通道安静且优先生效', () => {
  const r = runChild(VALID);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr.trim(), '', '有效变量不得报警告');
  assert.ok(r.stdout.includes(VALID), `应优先返回覆盖目录, got: ${r.stdout}`);
});

test('only-once:同进程两次 resolveDir 只警告一条(防刷屏)', () => {
  const r = runChild('D:/definitely-not-here', 2);
  assert.strictEqual(r.status, 0, r.stderr);
  const n = (r.stderr.match(/KHY_MD_TOOLS_DIR 指向/g) || []).length;
  assert.strictEqual(n, 1, `应恰 1 条警告, got ${n}:\n${r.stderr}`);
});

// 防幻影:警告文本必须真在被测模块源码里,而非只存在于测试断言中
test('防幻影:markdownWorkbench 源码含 _warnIgnoredOverride 调用点', () => {
  const src = require('fs').readFileSync(MOD, 'utf8');
  assert.match(src, /_warnIgnoredOverride\(envDir\)/);
  assert.match(src, /if \(envDir\)/, '警告须以「env 已设」为前提,未设不得触发');
});
