'use strict';

/**
 * safetyNotice.test.js — 单元**契约**测试（与 onboardingPlan.test.js 同层、同理由）。
 *
 * 这叶子存在的唯一理由是：CC 的两条安全原则（接受前审阅改动 / 只在信任的项目上用）
 * 在 khy 的引导里曾经**无处触达用户**。所以本文件钉的不只是形状，还有那两条内容本身：
 * 删掉任何一条 = 把补上的缺口重新挖开，必须让测试亮。
 *
 * runner：node:test（jest.config.js 按 `require('node:test')` 标记自动忽略本文件）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LEAF_PATH = path.join(__dirname, 'safetyNotice.js');
const leaf = require('./safetyNotice.js');
const LEAF_SRC = fs.readFileSync(LEAF_PATH, 'utf8');

// ESC 用字符码拼，避免在本文件里落下字面转义序列（DECSTBM 扫描会按形状误判）。
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`);
const KEY = 'KHY_ONBOARDING_SAFETY_NOTICE';

test('契约 1 导出面：不多不少', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['SECURITY_URL', 'buildSafetyNoticeLines', 'safetyNoticeEnabled']);
});

test('契约 2 纯度：零依赖、未着色、只产字符串数组', () => {
  assert.ok(!/\brequire\s*\(/.test(LEAF_SRC), 'safetyNotice.js 里出现了模块加载调用，纯度契约破了');
  const lines = leaf.buildSafetyNoticeLines({});
  assert.ok(Array.isArray(lines) && lines.length > 0);
  for (const line of lines) {
    assert.strictEqual(typeof line, 'string');
    assert.ok(!ANSI_RE.test(line), `叶子不该着色，实测：${line}`);
  }
});

test('契约 3 两条安全原则都在屏上（内容的存在理由）', () => {
  const text = leaf.buildSafetyNoticeLines({}).join('\n');
  assert.match(text, /接受前务必审阅/);
  assert.match(text, /只在你信任的项目上使用/);
  assert.match(text, /提示词注入/, 'prompt injection 必须点名');
  assert.match(text, /模型可能出错/, '必须诚实说明模型会犯错');
  assert.ok(text.includes(leaf.SECURITY_URL), '安全指南链接必须随行');
  assert.match(leaf.SECURITY_URL, /^https:\/\//);
});

test('契约 4 门控梯：关闭取值一律返回空数组（逐字节回退引导）', () => {
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.strictEqual(leaf.safetyNoticeEnabled({ [KEY]: off }), false, `off 值 ${JSON.stringify(off)}`);
    assert.deepStrictEqual(leaf.buildSafetyNoticeLines({ [KEY]: off }), [], `off 值 ${JSON.stringify(off)} 必须零行`);
  }
  for (const on of [undefined, '', '1', 'true', 'anything']) {
    assert.strictEqual(leaf.safetyNoticeEnabled(on === undefined ? {} : { [KEY]: on }), true);
    assert.ok(leaf.buildSafetyNoticeLines(on === undefined ? {} : { [KEY]: on }).length > 0);
  }
});

test('契约 4b 门控语义与同单元 onboardingPlan.isEnabled 不一致（空串）—— 已登记，非本测杜撰', () => {
  // onboardingPlan.isEnabled 把「设了但为空」算关（_OFF 之外还显式收了 ''），
  // 本叶子只看 ['0','false','off','no']，空串算开。同一单元两套门控语义，
  // 记在 [DESIGN-LAY-008] §12.3 缺陷账里；这条断言钉的是**现状**，改任一边都会亮。
  assert.strictEqual(leaf.safetyNoticeEnabled({ [KEY]: '' }), true);
  assert.strictEqual(require('./onboardingPlan.js').isEnabled({ KHY_ONBOARDING_COMMAND: '' }), false);
});

test('契约 5 env 只认注入：进程环境里的门控值必须被忽略', () => {
  const saved = process.env[KEY];
  process.env[KEY] = '0';
  try {
    assert.strictEqual(leaf.safetyNoticeEnabled({}), true, '叶子偷读了 process.env，注入契约破了');
    assert.ok(leaf.buildSafetyNoticeLines({}).length > 0);
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});

test('契约 6 绝不抛且确定：垃圾入参安全，同一入参两次逐字节相同', () => {
  for (const v of [{}, { [KEY]: 'x' }, [], 'x']) {
    assert.doesNotThrow(() => leaf.safetyNoticeEnabled(v));
    assert.doesNotThrow(() => leaf.buildSafetyNoticeLines(v));
  }
  const a = leaf.buildSafetyNoticeLines({}).join('\n');
  const b = leaf.buildSafetyNoticeLines({}).join('\n');
  assert.strictEqual(a, b);
});
