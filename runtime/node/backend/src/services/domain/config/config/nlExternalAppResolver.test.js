'use strict';

// Co-located contract tests for nlExternalAppResolver.js (纯叶子 NL → 给外部软件配模型)。
// Measured via .khyos/tmp/probeApp.js. Zero-IO, but resolve/isEnabled default to the real
// process.env, so every call injects an env object. Keys used below are synthetic fakes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isEnabled, resolve, _extractApp, _extractProvider } = require('./nlExternalAppResolver');

const ON = { KHY_NL_EXTERNAL_APP: 'true' };

test('门控默认开，仅 CANON 四词关；空串读作开而数字 0 读作关', () => {
  assert.equal(isEnabled({}), true);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', ' Off ', 'No']) {
    assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP: word }), false, `${word} closes`);
  }
  for (const word of ['', null, undefined, 'true', '1', 'NOPE', 'off-line']) {
    assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP: word }), true, `${String(word)} stays open`);
  }
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP: 0 }), false);
  assert.equal(isEnabled({ KHY_NL_EXTERNAL_APP: false }), false);
  assert.equal(isEnabled(null), true);
  assert.equal(isEnabled(0), false, 'the falsy env itself is stringified to "0"');
  assert.equal(isEnabled('x'), true);
});

test('闸门①：必须点名 6 个外部软件之一，否则交给别的叶子', () => {
  assert.equal(resolve('配置一下环境', ON), null);
  assert.equal(resolve('删除这行代码', ON), null);
  assert.equal(resolve('添加 kimi 模型', ON), null, 'a provider without an app is nlProviderResolver territory');
  assert.deepEqual(resolve('给 opencode 添加 deepseek 模型', ON), {
    app: 'opencode', action: 'add', provider: 'deepseek', apiKey: '', model: '', endpoint: '',
  });
});

test('_extractApp 按最早出现位取 app，别名表覆盖 6 个软件的多种写法且大小写折叠', () => {
  assert.equal(_extractApp('deepseek reasonix 的模型'), 'reasonix');
  assert.equal(_extractApp('open claw 模型 与 opencode'), 'openclaw');
  assert.equal(_extractApp('coze studio 模型'), 'coze');
  assert.equal(_extractApp('ds-tui 模型'), 'deepseek-tui');
  assert.equal(_extractApp('扣子 模型'), 'coze');
  assert.equal(_extractApp('claude code 模型'), 'claude-code');
  assert.equal(_extractApp('OPENCODE 模型'), 'opencode');
  assert.equal(_extractApp('没有任何应用'), '');
  for (const junk of [null, undefined, 0, '', {}, [], NaN, false]) {
    assert.equal(_extractApp(junk), '', `junk ${String(junk)}`);
  }
});

test('闸门②：领域引用（模型/供应商/密钥/endpoint）必须出现', () => {
  assert.equal(resolve('opencode 怎么用', ON), null, 'usage chatter');
  assert.equal(resolve('怎么使用 opencode', ON), null);
  assert.equal(resolve('配置 claude code 使用 deepseek', ON), null, 'a vendor name alone is not a domain token');
  assert.equal(resolve('查询 opencode 的 deepseek 信息', ON), null, 'even a get intent needs the domain word');
  assert.deepEqual(resolve('给 opencode 设置 供应商 x 的 api key sk-abcdef123456', ON).action, 'add');
});

test('add 至少要抓到 provider 或 model，否则只拒绝不猜（密钥本身不构成意图）', () => {
  assert.equal(resolve('给 coze 加 key sk-abcdef123456', ON), null);
  assert.equal(resolve('给 opencode 设置 api key sk-abcdef123456', ON), null);
  assert.equal(resolve('opencode 密钥 sk-abcdef123456', ON), null);
  assert.equal(resolve('给 opencode 加一个模型', ON), null, 'an unspecific 模型 has no name to write');
  assert.equal(resolve('给 opencode 更新模型', ON), null);
  assert.deepEqual(resolve('给 opencode 加一个 qwen 模型', ON), {
    app: 'opencode', action: 'add', provider: 'qwen', apiKey: '', model: '', endpoint: '',
  });
});

test('add 抽出 provider/model/apiKey/endpoint 四字段，缺位一律空串', () => {
  assert.deepEqual(resolve('给 openclaw 配置 provider 为 moonshot 的 api key sk-abcdef123456', ON), {
    app: 'openclaw', action: 'add', provider: 'moonshot', apiKey: 'sk-abcdef123456', model: '', endpoint: '',
  });
  assert.deepEqual(resolve('把 opencode 的 endpoint 配置为 https://a.b/v1，模型 glm-4', ON), {
    app: 'opencode', action: 'add', provider: 'glm', apiKey: '', model: 'glm-4', endpoint: 'https://a.b/v1',
  });
  assert.deepEqual(resolve('给 opencode 添加 anthropic 的 模型 claude-3-7', ON), {
    app: 'opencode', action: 'add', provider: 'anthropic', apiKey: '', model: 'claude-3-7', endpoint: '',
  });
  assert.deepEqual(Object.keys(resolve('给 coze 配置模型为 doubao-pro', ON)), ['app', 'action', 'provider', 'apiKey', 'model', 'endpoint']);
});

test('厂商别名表把中文与英文写法映射到规范 provider id', () => {
  for (const [alias, id] of [
    ['deepseek', 'deepseek'], ['深度求索', 'deepseek'], ['openai', 'openai'], ['gpt', 'openai'],
    ['gemini', 'gemini'], ['google', 'gemini'], ['grok', 'grok'], ['xai', 'grok'],
    ['kimi', 'moonshot'], ['moonshot', 'moonshot'], ['智谱', 'glm'], ['glm', 'glm'],
    ['豆包', 'doubao'], ['ark', 'doubao'], ['qwen', 'qwen'], ['千问', 'qwen'], ['openrouter', 'openrouter'],
  ]) {
    assert.equal(_extractProvider(`给 opencode 加 ${alias} 模型`), id, alias);
  }
  assert.equal(_extractProvider('给 opencode 添加 gpt-4o 模型'), 'openai', 'the alias table is a substring scan');
});

test('app 名内嵌的厂商名不会串扰成 provider（先抹掉 app 别名再扫别名表）', () => {
  assert.equal(_extractProvider('deepseek-tui 里加 openai 模型'), 'openai', 'deepseek-tui must not yield deepseek');
  assert.deepEqual(resolve('给 deepseek-tui 添加 kimi 模型', ON).provider, 'moonshot');
  assert.deepEqual(resolve('给 deepseek reasonix 添加 智谱 模型', ON), {
    app: 'reasonix', action: 'add', provider: 'glm', apiKey: '', model: '', endpoint: '',
  });
  assert.equal(_extractProvider('给 opencode 配置 anthropic 的模型'), 'anthropic');
});

test('remove 优先且必须有具体目标；目标可来自删除后名字或厂商别名回退', () => {
  assert.deepEqual(resolve('移除 claude code 的 provider moonshot', ON), {
    app: 'claude-code', action: 'remove', target: 'moonshot', confirmed: false, removeKeys: false,
  });
  assert.deepEqual(resolve('删除 opencode 里的 deepseek 模型', ON).target, 'deepseek');
  assert.deepEqual(resolve('rm opencode 的 gpt 模型', ON).target, 'openai', 'app name is a stopword, so the alias fallback runs');
  assert.equal(resolve('删除 opencode', ON), null, 'nothing to delete but the app itself');
  assert.equal(resolve('删除 opencode 的模型', ON), null, 'the word 模型 is a stopword, not a target');
  assert.equal(resolve('删除 opencode 里的所有模型', ON), null);
});

test('remove 的 confirmed/removeKeys 只在显式措辞下为真', () => {
  assert.deepEqual(resolve('删掉 coze 的 gpt 模型，确认', ON), {
    app: 'coze', action: 'remove', target: 'openai', confirmed: true, removeKeys: false,
  });
  assert.equal(resolve('remove openclaw provider xai 连密钥一起删', ON).removeKeys, true);
  assert.equal(resolve('remove openclaw provider xai 连密钥一起删', ON).confirmed, false);
  assert.equal(resolve('删除 opencode 里的 deepseek 模型', ON).confirmed, false);
});

test('list 只读兜底：add 未成立时仍能落到 list', () => {
  assert.deepEqual(resolve('列出 opencode 的模型', ON), { app: 'opencode', action: 'list' });
  assert.deepEqual(resolve('查看 coze 里的模型', ON), { app: 'coze', action: 'list' });
  assert.deepEqual(resolve('opencode 有哪些模型', ON), { app: 'opencode', action: 'list' });
  assert.deepEqual(resolve('看看 opencode 的模型', ON), { app: 'opencode', action: 'list' });
  assert.deepEqual(resolve('show opencode providers', ON), { app: 'opencode', action: 'list' });
  assert.deepEqual(resolve('列出 coze 的供应商', ON), { app: 'coze', action: 'list' });
});

test('get 需要点出具体 provider 或模型名，否则不接管', () => {
  assert.deepEqual(resolve('查一下 opencode 的 moonshot 模型', ON), { app: 'opencode', action: 'get', target: 'moonshot' });
  assert.deepEqual(resolve('get info on opencode model gpt-4o', ON), { app: 'opencode', action: 'get', target: 'openai' });
  assert.equal(resolve('opencode 的模型详情', ON), null, 'no name to look up');
  assert.equal(resolve('opencode 详情', ON), null, 'and no domain token at all');
  assert.equal(resolve('opencode 的模型信息', ON), null);
});

test('KNOWN-DEFECT 动作词表没有「设为」，同一句换成 配置/改成 就成立', () => {
  assert.equal(resolve('把 opencode 的 模型 设为 glm-4', ON), null, '设为 is absent from _ADD_RE');
  assert.equal(resolve('把 opencode 的 endpoint 设为 https://a.b/v1，模型 glm-4', ON), null);
  assert.equal(resolve('把 opencode 的 模型 配置为 glm-4', ON).action, 'add');
  assert.deepEqual(resolve('把 opencode 的模型改成 qwen3-max', ON), {
    app: 'opencode', action: 'add', provider: 'qwen', apiKey: '', model: '', endpoint: '',
  }, '改成 works but also rewrites 模型名 into the provider field');
});

test('KNOWN-DEFECT 领域词只认单数 model：英文复数 models 直接不过闸门，姊妹导入叶子却接受', () => {
  assert.equal(resolve('list models in opencode', ON), null, 'the import leaf matches \\bmodel(?:s)?\\b');
  assert.deepEqual(resolve('list model in opencode', ON), { app: 'opencode', action: 'list' });
  assert.deepEqual(resolve('show opencode providers', ON), { app: 'opencode', action: 'list' }, 'singular provider is fine');
  assert.equal(resolve('查看 opencode 的模型', ON).action, 'list', 'Chinese is unaffected');
});

test('KNOWN-DEFECT 名字抽取没有停用词守卫：endpoint/details/设置为/名 都会当名字返回', () => {
  assert.deepEqual(resolve('添加 openclaw 模型 endpoint https://a.b/v1', ON), {
    app: 'openclaw', action: 'add', provider: '', apiKey: '', model: 'endpoint', endpoint: 'https://a.b/v1',
  }, 'the word endpoint is captured as the model id');
  assert.deepEqual(resolve('opencode model details', ON), { app: 'opencode', action: 'get', target: 'details' });
  assert.equal(_extractProvider('把供应商设置为 添加'), '设置为', '设置为 is not in _STOPWORDS');
  assert.equal(_extractProvider('供应商名：moonshot'), '名', 'the 名 marker swallows the real vendor');
  assert.equal(resolve('给 opencode 添加 openai 模型', ON).provider, 'openai', 'the clean path still works');
});

test('门控关时 resolve 恒 null；长度 500 闭区间', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(resolve('给 opencode 添加 deepseek 模型', { KHY_NL_EXTERNAL_APP: off }), null);
  }
  const base = '给 opencode 添加 deepseek 模型';
  const at500 = base + '。'.repeat(500 - base.length);
  assert.equal(at500.length, 500);
  assert.equal(resolve(at500, ON).app, 'opencode');
  assert.equal(resolve(`${at500}。`, ON), null);
  assert.equal(resolve(`${'x'.repeat(501)} 给 opencode 添加 deepseek 模型`, ON), null);
});

test('垃圾输入一律 null 且绝不抛（契约 fail-soft）', () => {
  for (const junk of [null, undefined, '', '   ', 0, 123, NaN, true, false, [], {}, new Set()]) {
    assert.equal(resolve(junk, ON), null, `junk ${String(junk)}`);
  }
  assert.equal(resolve({
    toString() { throw new Error('boom'); },
  }, ON), null);
  assert.doesNotThrow(() => resolve({
    toString() { throw new Error('boom'); },
  }, ON));
});

test('四种动作的键集互不相同，返回对象每次新建', () => {
  assert.deepEqual(Object.keys(resolve('给 opencode 添加 deepseek 模型', ON)), ['app', 'action', 'provider', 'apiKey', 'model', 'endpoint']);
  assert.deepEqual(Object.keys(resolve('列出 opencode 的模型', ON)), ['app', 'action']);
  assert.deepEqual(Object.keys(resolve('查一下 opencode 的 moonshot 模型', ON)), ['app', 'action', 'target']);
  assert.deepEqual(Object.keys(resolve('删除 opencode 里的 deepseek 模型', ON)), ['app', 'action', 'target', 'confirmed', 'removeKeys']);
  const a = resolve('列出 opencode 的模型', ON);
  assert.notEqual(a, resolve('列出 opencode 的模型', ON));
});

test('解析不改动注入的 env', () => {
  const env = { KHY_NL_EXTERNAL_APP: 'true', KEEP: 'me' };
  resolve('给 opencode 添加 deepseek 模型', env);
  isEnabled(env);
  assert.deepEqual(env, { KHY_NL_EXTERNAL_APP: 'true', KEEP: 'me' });
});
