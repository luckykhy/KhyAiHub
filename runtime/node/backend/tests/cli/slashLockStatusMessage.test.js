'use strict';

/**
 * slashLockStatusMessage.test.js — 斜杠命令并发锁那句拒绝语必须说清「哪条命令 · 已等多久」
 * （AGENTS.md 规则 2 / RUNTIME-002，node:test，零 IO）。
 *
 * 为什么钉这一句：2026-11-15 用仓里自己的检查器把**整片 CLI**（663 文件，不是 --changed）
 * 扫了一遍，规则 2 只剩一处违规——router.js 的并发锁在被重入时打
 * `另一个命令正在执行中,请稍候...`。「请稍候…」是 AGENTS.md 逐字禁止的形状，
 * 而且它出现的时刻恰恰是用户最没信息的那一刻：他刚按下的东西没被执行，却不知道被什么挡住、
 * 要等多久。改后实测原文：
 *   ⚠ 斜杠命令「/gateway status」仍在执行（已等 不到 1 秒），这条先不接，等它跑完再输下一条
 *
 * 为什么锁形状不锁行为：真并发要「第一条命令还挂着」才打得出这句，测试里造这个条件
 * 依赖 /gateway status 的探测时长——网络环境一变就是随机红。所以行为证据走 pty/探针
 * （见 works/data/khy/feedback/slash-lock-status-20261115/），这里只钉**文案形状**：
 * 谁在跑 · 等了多久 · 不许再出现被禁的含糊词。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'cli', 'router.js'),
  'utf8'
);

// The whole refusal branch: guard line through its `return true`. The waiting text is built
// on the line ABOVE printWarn, so slicing only the call would miss the sub-second branch
// (it did, on the first run of this file).
function lockRefusal() {
  const guard = SRC.indexOf('if (_slashCommandInFlight && !context.delegated)');
  assert.ok(guard > 0, 'router.js 里找不到斜杠命令并发锁的判断式 —— 本文件判据失去对照物');
  const ret = SRC.indexOf('return true', guard);
  assert.ok(ret > guard, '并发锁分支里没有 return true：拒绝语义可能被改掉了');
  const block = SRC.slice(guard, ret);
  assert.match(block, /printWarn\(/, '并发锁分支里没有 printWarn：拒绝重入变成了静默吞键，比含糊更糟');
  return block;
}

test('并发锁的拒绝语必须点名在跑的那条命令，并给出已等待时长', () => {
  const stmt = lockRefusal();
  assert.match(stmt, /斜杠命令「\$\{/, `拒绝语没点名是哪条命令在跑：\n${stmt}`);
  assert.match(stmt, /已等/, `拒绝语没给等待时长（动作+目标+进度缺「进度」）：\n${stmt}`);
  // 两个时长分支都要在：只剩一个意味着窄情况会打出「已等 0 秒」这类无意义数。
  assert.match(stmt, /不到 1 秒/, '缺少亚秒分支');
  assert.match(stmt, /toFixed\(1\)} 秒/, '缺少秒级分支');
});

test('拒绝语不得回到 AGENTS.md 逐字禁止的含糊形状', () => {
  const stmt = lockRefusal();
  assert.doesNotMatch(stmt, /请稍候/, '「请稍候…」是规则 2 逐字禁止的措辞');
  assert.doesNotMatch(stmt, /正在执行中(?![^」]*」)/, '回到「正在执行中」这种无目标说法');
  assert.doesNotMatch(stmt, /处理中|尝试连接/, '规则 2 禁止的含糊 token 又回来了');
});

test('正对照：拒绝分支确实还在（不是靠删掉这段代码通过上两条）', () => {
  const guard = SRC.indexOf('if (_slashCommandInFlight && !context.delegated)');
  const block = SRC.slice(guard, SRC.indexOf('}', SRC.indexOf('return true', guard)) + 1);
  assert.match(block, /printWarn\(/);
  assert.match(block, /return true/);
});
