'use strict';

/**
 * assistantStatusChinese.test.js — 锁 `khy assistant status` 屏为中文且值列对齐。
 *
 * 复现真实路径:featureFlags 默认开助手,handler 直接渲染。回归两类缺陷:
 * (1) 面向用户字符串回退英文(违反 AGENTS.md「面向用户的字符串:中文」);
 * (2) 中文标签变宽后破坏值列对齐(CJK 双宽,须 padToWidth 到固定显示列)。
 */

const assert = require('assert');
const nt = require('node:test');

const HANDLER = require.resolve('../../../src/cli/handlers/assistant');
const { displayWidth } = require('../../../src/cli/formatters');

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  return fn()
    .catch((e) => lines.push('ERR ' + e.message))
    .then(() => {
      console.log = orig;
      return lines;
    });
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

nt.test('status 屏标签全中文,无英文裸标签回退', async () => {
  process.env.KHY_FEATURE_ASSISTANT = 'true';
  delete require.cache[HANDLER];
  const { handleAssistantCommand } = require(HANDLER);
  const lines = (await capture(() => handleAssistantCommand('status', [], {}))).map(strip);
  const text = lines.join('\n');
  // 中文标签必须出现
  for (const lbl of ['模式:', '主动:', '日志文件:', '上次整理:', '待整理:', '原因:']) {
    assert.ok(text.includes(lbl), `缺少中文标签 ${lbl}`);
  }
  // 旧英文标签不得回归
  for (const en of ['Mode:', 'Proactive:', 'Log files:', 'Last dream:', 'Dream need:', 'Reason:', 'ACTIVE', 'INACTIVE']) {
    assert.ok(!text.includes(en), `英文标签回归: ${en}`);
  }
});

nt.test('状态值列按显示宽度对齐(CJK 标签不破坏列)', async () => {
  process.env.KHY_FEATURE_ASSISTANT = 'true';
  delete require.cache[HANDLER];
  const { handleAssistantCommand } = require(HANDLER);
  const lines = (await capture(() => handleAssistantCommand('status', [], {}))).map(strip);
  const cols = [];
  for (const t of lines) {
    const m = t.match(/^  (\S+?:)( +)(.+)$/);
    if (m) cols.push(2 + displayWidth(m[1] + m[2]));
  }
  assert.ok(cols.length >= 5, `应至少 5 行标签:值,实际 ${cols.length}`);
  assert.ok(
    cols.every((c) => c === cols[0]),
    `值列不对齐: ${JSON.stringify(cols)}`
  );
});

nt.test('dream 原因(模块数据)为中文,不在中文标签下吐英文', async () => {
  process.env.KHY_FEATURE_ASSISTANT = 'true';
  delete require.cache[HANDLER];
  const { handleAssistantCommand } = require(HANDLER);
  const lines = (await capture(() => handleAssistantCommand('status', [], {}))).map(strip);
  const reasonLine = lines.find((t) => t.includes('原因:'));
  assert.ok(reasonLine, '应有原因行');
  const val = reasonLine.split('原因:')[1].trim();
  assert.ok(/[一-鿿]/.test(val), `原因值应为中文: ${val}`);
  assert.ok(!/[a-z]{4,}/i.test(val), `原因值不应含英文词: ${val}`);
});
