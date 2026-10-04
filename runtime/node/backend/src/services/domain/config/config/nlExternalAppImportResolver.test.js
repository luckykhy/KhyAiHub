'use strict';

// Co-located contract tests for nlExternalAppImportResolver.js (纯叶子，反向「导入外部软件模型」)。
// All expectations are MEASURED (.khyos/tmp probes). The leaf reads no disk/network, but
// `resolve`/`isEnabled` default to the real process.env, so every call injects an env object.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isEnabled, resolve, _extractApp } = require('./nlExternalAppImportResolver');

const ON = { KHY_NL_EXTERNAL_APP_IMPORT: 'true' };
const OFF = { KHY_NL_EXTERNAL_APP_IMPORT: 'off' };

test('门控默认开，仅 CANON 四个关词生效，关词外一律开', () => {
  assert.equal(isEnabled({}), true);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', ' Off ', 'No', 'FALSE']) {
    assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: word }), false, `${word} closes the gate`);
  }
  for (const word of ['true', '1', 'yes', 'nope', 'off-line', 'banana']) {
    assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: word }), true, `${word} keeps it open`);
  }
});

test('门控把空串/null 读作开，却把数字 0/布尔 false 读作关（字符串化后判定）', () => {
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: '' }), true);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: null }), true);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: undefined }), true);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: 0 }), false);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: 1 }), true);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: false }), false);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP_IMPORT: true }), true);
});

test('门控对 env 载体本身取真假：null/字符串/数组都当作「未设」，0 被当成字面 "0"', () => {
  assert.equal(isEnabled(null), true);
  assert.equal(isEnabled(undefined), true);
  assert.equal(isEnabled('x'), true);
  assert.equal(isEnabled([]), true);
  assert.equal(isEnabled(0), false);
  assert.equal(isEnabled(false), false);
});

test('强反向动词单独成立，即使句中还带正向配置词', () => {
  assert.deepEqual(resolve('导入 claude code 的模型', ON), { app: 'claude-code', action: 'import' });
  assert.deepEqual(resolve('复用 deepseek reasonix 配置的模型', ON), { app: 'reasonix', action: 'import' });
  assert.deepEqual(resolve('把 opencode 的模型注册进 khy', ON), { app: 'opencode', action: 'import' });
  assert.deepEqual(resolve('复用 openclaw 的模型，再配置 coze 的模型', ON), { app: 'openclaw', action: 'import' });
  assert.deepEqual(resolve('从 opencode 拿过来用模型', ON), { app: 'opencode', action: 'import' });
  assert.deepEqual(resolve('接入到 khy 的 opencode 模型', ON), { app: 'opencode', action: 'import' });
});

test('弱反向动词只在没有正向配置动作时接管（让位给正向 resolver）', () => {
  assert.deepEqual(resolve('用 opencode 里的模型', ON), { app: 'opencode', action: 'import' });
  assert.deepEqual(resolve('使用 coze 的模型', ON), { app: 'coze', action: 'import' });
  assert.deepEqual(resolve('use opencode models', ON), { app: 'opencode', action: 'import' });
  assert.equal(resolve('配置 claude code 使用 deepseek 模型', ON), null);
  assert.equal(resolve('可以用 opencode 的模型来配置 deepseek', ON), null);
  assert.equal(resolve('给 opencode 配置 deepseek 模型', ON), null);
  assert.equal(resolve('添加 opencode 模型', ON), null);
});

test('模型领域词是硬门控，缺它或写法不连写都不接管', () => {
  assert.equal(resolve('怎么使用 opencode', ON), null, 'talking about the app itself');
  assert.equal(resolve('opencode 的模型', ON), null, 'domain word without any use verb');
  assert.equal(resolve('导入模型', ON), null, 'no app name and no "所有外部软件" scope');
  assert.equal(resolve('用 opencode 的 模 型', ON), null, 'the token must be contiguous');
  assert.deepEqual(resolve('用 coze-studio 的 LLM', ON), { app: 'coze', action: 'import' });
  assert.deepEqual(resolve('用 opencode 的大模型', ON), { app: 'opencode', action: 'import' });
  assert.deepEqual(resolve('用 opencode 的 model', ON), { app: 'opencode', action: 'import' });
});

test('app 别名表覆盖 6 个软件的多种写法并按最早出现位取胜', () => {
  for (const [phrase, app] of [
    ['用 opencode 的模型', 'opencode'],
    ['用 open code 的模型', 'opencode'],
    ['用 open claw 的模型', 'openclaw'],
    ['用 claudecode 的模型', 'claude-code'],
    ['用扣子的模型', 'coze'],
    ['用 ds-tui 的模型', 'deepseek-tui'],
    ['用 deepseek 终端的模型', 'deepseek-tui'],
    ['用 deepseek-tui 的模型', 'deepseek-tui'],
  ]) {
    assert.deepEqual(resolve(phrase, ON), { app, action: 'import' }, phrase);
  }
  assert.deepEqual(resolve('用 coze 模型 与 opencode 模型', ON), { app: 'coze', action: 'import' });
  assert.deepEqual(resolve('用 opencode 模型 与 coze 模型', ON), { app: 'opencode', action: 'import' });
  assert.equal(_extractApp('deepseek-reasonix 与 opencode'), 'reasonix');
});

test('_extractApp 只认表内别名，大小写折叠，认不出返回空串', () => {
  assert.equal(_extractApp('用 OPENCODE 的模型'), 'opencode');
  assert.equal(_extractApp('用 deepseek 的模型'), '', 'bare "deepseek" is a provider, not an app');
  assert.equal(_extractApp('没有名字'), '');
  for (const junk of [null, undefined, 0, {}, [], '']) {
    assert.equal(_extractApp(junk), '', `junk ${String(junk)} yields the empty app`);
  }
  assert.equal(resolve('用 deepseek 的模型', ON), null, 'and the resolver then refuses to guess');
});

test('无 app 名时只有「所有/全部/每个/这些 + 软件/app」才走整体导入', () => {
  assert.deepEqual(resolve('用所有外部软件的模型', ON), { action: 'import', all: true });
  assert.deepEqual(resolve('导入全部外部软件的模型', ON), { action: 'import', all: true });
  assert.deepEqual(resolve('使用所有外部软件里的模型', ON), { action: 'import', all: true });
  assert.deepEqual(resolve('把每个软件的模型都拿来用', ON), { action: 'import', all: true });
  assert.deepEqual(resolve('导入这些 app 的模型', ON), { action: 'import', all: true });
  assert.deepEqual(resolve('用每个 app 的模型', ON), { action: 'import', all: true });
  assert.equal(resolve('用所有模型的导入', ON), null, 'a scope word without a software noun');
});

test('门控关时 resolve 恒 null，即便文本完全命中', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(resolve('用 opencode 里的模型', { KHY_NL_EXTERNAL_APP_IMPORT: off }), null);
  }
  assert.equal(resolve('用 opencode 里的模型', OFF), null);
  assert.deepEqual(resolve('用 opencode 里的模型', ON).app, 'opencode');
});

test('输入长度 500 为闭区间上界：500 内可解析，501 一律 null', () => {
  const base = '用 opencode 的模型';
  const at500 = base + '。'.repeat(500 - base.length);
  assert.equal(at500.length, 500);
  assert.deepEqual(resolve(at500, ON), { app: 'opencode', action: 'import' });
  assert.equal(resolve(`${at500}。`, ON), null, 'one char over the cap is refused outright');
  assert.equal(resolve(`${'x'.repeat(501)} 用 opencode 模型`, ON), null);
  assert.equal(resolve('x'.repeat(2000), ON), null);
});

test('垃圾输入一律 null 且绝不抛（契约 fail-soft）', () => {
  for (const junk of [null, undefined, '', '   ', 0, 123, NaN, true, false, [], {}, new Set()]) {
    assert.equal(resolve(junk, ON), null, `junk ${String(junk)}`);
  }
  assert.doesNotThrow(() => resolve({
    toString() { throw new Error('boom'); },
  }, ON));
  assert.equal(resolve({
    toString() { throw new Error('boom'); },
  }, ON), null);
});

test('返回体只有两种形状，且不带 success/error 之类的额外键', () => {
  assert.deepEqual(Object.keys(resolve('用 opencode 的模型', ON)).sort(), ['action', 'app']);
  assert.deepEqual(Object.keys(resolve('用所有外部软件的模型', ON)).sort(), ['action', 'all']);
  assert.equal('app' in resolve('用所有外部软件的模型', ON), false);
  assert.equal('all' in resolve('用 opencode 的模型', ON), false);
});

test('KNOWN-DEFECT 裸「用」必须紧跟在空白/标点/五个白名单字之后，否则自然请求全部漏判', () => {
  // "我来用 …" is caught (来 is whitelisted), "帮我用 / 请用 / 能否用 …" are not.
  assert.deepEqual(resolve('我来用 opencode 的模型', ON), { app: 'opencode', action: 'import' });
  for (const miss of ['请用 opencode 的模型', '帮我用 opencode 的模型', '能否用 opencode 的模型', '还是用 opencode 的模型', '改用 opencode 的模型', '试着用 opencode 的模型']) {
    assert.equal(resolve(miss, ON), null, miss);
  }
  // The same sentence does parse once a strong import verb is used.
  assert.deepEqual(resolve('请导入 opencode 的模型', ON), { app: 'opencode', action: 'import' });
});

test('解析不改动注入的 env 也不复用上一次结果对象', () => {
  const env = { KHY_NL_EXTERNAL_APP_IMPORT: 'true', KEEP: 'me' };
  const a = resolve('用 opencode 的模型', env);
  const b = resolve('用 opencode 的模型', env);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.deepEqual(env, { KHY_NL_EXTERNAL_APP_IMPORT: 'true', KEEP: 'me' });
});

test('叶子只导出三个面（正则常量全部私有，避免外部旁路）', () => {
  assert.deepEqual(Object.keys(require('./nlExternalAppImportResolver')).sort(), ['_extractApp', 'isEnabled', 'resolve']);
});
