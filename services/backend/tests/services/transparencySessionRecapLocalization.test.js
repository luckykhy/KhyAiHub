'use strict';

// transparencyService.formatSessionRecap 是会话退出时经 cli/transparency.js
// printSessionRecap 打印的整屏摘要，此前 7 个标签（Session Summary / Duration: /
// Tokens: / Cost: / Model: / Tool calls: / Top tools: / requests）全为硬编码英文，
// 违反 AGENTS.md「面向用户的字符串：中文」。本项曾以「宽度家族、需 displayWidth
// SSOT」为由只报不修——复核后发现该判断错误：六个数值行的标签虽列对齐到同一显示列，
// 但标签是**静态字符串**，其补齐可在编写期算定，无需运行时 displayWidth。
// 修复用一个本地叶子 _dlw（CJK/全角标点计 2 列）把每个标签补齐到 13 显示列，
// 数值统一从第 15 列起。本地实现而非复用 cli/formatters.js 的 displayWidth：后者是
// 作者脏文件且 services→cli 属反向依赖。本测试锁两面：
//   1) 中文标签出现、旧英文消失；2) 六个数值行的首个数值仍对齐到同一显示列（防宽度回归）。

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';

const assert = require('assert');
const nt = require('node:test');

const { formatSessionRecap } = require('../../src/services/transparencyService');

// 与源码一致的显示宽度算子：CJK 统一表意/全角标点计 2，其余计 1。
const dlw = (s) => [...String(s)].reduce(
  (w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

const SESSION = {
  durationMs: 125000,
  requestCount: 12,
  totalInputTokens: 1234,
  totalOutputTokens: 5678,
  totalCostUSD: 0.034,
  model: 'claude-sonnet',
  toolCallCount: 7,
  topTools: [{ name: 'Read', count: 3 }, { name: 'Edit', count: 2 }],
};

const OUT = formatSessionRecap(SESSION);

nt.describe('formatSessionRecap localized to Chinese (面向用户字符串)', () => {
  nt.test('seven Chinese labels present', () => {
    for (const h of ['会话摘要', '时长：', '词元：', '成本：', '模型：', '工具调用：', '常用工具：']) {
      assert.ok(OUT.includes(h), `expected Chinese label: ${h}`);
    }
    assert.ok(/次请求/.test(OUT), 'requests unit localized');
  });

  nt.test('old English labels gone (anti-regression)', () => {
    for (const bad of ['Session Summary', 'Duration:', 'Tokens:', 'Cost:', 'Model:',
      'Tool calls:', 'Top tools:', ' requests']) {
      assert.ok(!OUT.includes(bad), `expected NOT to contain: ${bad}`);
    }
  });
});

nt.describe('formatSessionRecap value column stays aligned (width family)', () => {
  // 六行数值须从同一显示列起始；手改补齐空格会破坏此契约。
  const ROWS = [
    ['时长：', '2m'],
    ['词元：', '↑'],
    ['成本：', '$'],
    ['模型：', 'claude-sonnet'],
    ['工具调用：', '7'],
    ['常用工具：', 'Read'],
  ];
  nt.test('non-vacuity: all six rows located', () => {
    for (const [label] of ROWS) {
      assert.ok(OUT.split('\n').some((l) => l.includes(label)), `missing row ${label}`);
    }
  });
  nt.test('every value starts at the same display column', () => {
    const cols = ROWS.map(([label, valueToken]) => {
      const line = OUT.split('\n').find((l) => l.includes(label));
      const i = line.indexOf(label) + label.length;
      const after = line.slice(i);
      const spaces = (after.match(/^ +/) || [''])[0].length;
      return dlw(line.slice(0, i)) + spaces; // 数值首字符的显示列
    });
    assert.ok(new Set(cols).size === 1, `value columns diverge: ${JSON.stringify(cols)}`);
    assert.ok(cols[0] >= 10, `alignment target implausible: ${cols[0]}`);
  });
});
