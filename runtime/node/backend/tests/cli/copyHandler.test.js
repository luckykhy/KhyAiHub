'use strict';
// 契约(轮二十四):`copy <无法识别的 token>` 必须**就地拒绝并点名坏参数**,
// 绝不再静默改抄「最近一条助手回复」打印成功(病症:`copy /no/a /no/b` →
// 「✓ 已复制到剪贴板(native):最近一条助手回复(21 字)」rc=0)。
// 拒绝路径须在会话读取/剪贴板写入之前——用「ccClipboard 模块根本未被加载」证明。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const HANDLER = path.join(BE, 'src/cli/handlers/copy.js');
const CLIP = path.join(BE, 'src/cli/tui/utils/ccClipboard.js');

function freshHandler() {
  delete require.cache[require.resolve(HANDLER)];
  return require(HANDLER);
}

async function runCapture(subCommand, args) {
  const fmtPath = require.resolve(path.join(BE, 'src/cli/formatters.js'));
  const fmt = require(fmtPath);
  const savedErr = fmt.printError;
  const lines = [];
  fmt.printError = (m) => lines.push(String(m));
  try {
    const handled = await freshHandler().handleCopy(subCommand, args, {});
    return { handled, out: lines.join('\n') };
  } finally {
    fmt.printError = savedErr;
  }
}

test('copy /no/a /no/b → 拒绝并逐一点名坏 token,不返回成功回执', async () => {
  const { handled, out } = await runCapture('/no/a', ['/no/b']);
  assert.equal(handled, true);
  assert.match(out, /无法识别的参数/);
  assert.match(out, /\/no\/a/, '须点名第一个坏 token');
  assert.match(out, /\/no\/b/, '须点名第二个坏 token');
  assert.doesNotMatch(out, /已复制到剪贴板/, '拒绝路径不得再打成功');
  assert.match(out, /用法[:：]/, '须给出正确用法(Rule 2.2 修复建议)');
});

test('拒绝发生在读会话/写剪贴板之前:ccClipboard 模块未被加载', async () => {
  delete require.cache[require.resolve(CLIP)];
  await runCapture('/no/a', []);
  assert.ok(
    !(require.resolve(CLIP) in require.cache),
    '剪贴板出口不应被触碰——参数就该被拒'
  );
});

test('显式空参数 copy "" → 点名拒绝(resume "" 同族,轮二十五/二十六一致性)', async () => {
  const { out } = await runCapture(null, ['']);
  assert.match(out, /无法识别的参数/);
  assert.match(out, /''/, '空串须以可见形式点名');
});

test('合法 token(纯数字 / code)不被误伤,且照常走到剪贴板出口', async () => {
  // nth 与 code 都属合法语法,不得进「无法识别」分支。
  // 桩住剪贴板出口,测试绝不真写系统剪贴板;断言出口被调用即证明未被拒。
  const clip = require(CLIP);
  const saved = clip.writeClipboard;
  let calls = 0;
  clip.writeClipboard = () => {
    calls += 1;
    return { ok: true, channels: ['stub'], bytes: 1 };
  };
  try {
    for (const tokens of [['2'], ['code'], ['code', '3']]) {
      const { out } = await runCapture(tokens[0], tokens.slice(1));
      assert.doesNotMatch(out, /无法识别的参数/, `合法 token 被误拒: ${tokens.join(' ')}`);
    }
  } finally {
    clip.writeClipboard = saved;
  }
});
