'use strict';

// Co-located contract tests for nlProviderResolver.js (纯叶子 NL → provider 意图)。
// The leaf is zero-IO; `resolve`/`isEnabled` default to the real process.env, so every call injects
// an env object. All keys below are SYNTHETIC fakes — nothing here is, or asserts, a real credential.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isEnabled, resolve } = require('./nlProviderResolver');

const ON = { KHY_NL_PROVIDER: 'true' };
const SK = 'sk-abc123456';

test('门控默认开，仅 CANON 四词关；空串/null 读作开，数字 0 读作关', () => {
  assert.equal(isEnabled({}), true);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(isEnabled({ KHY_NL_PROVIDER: word }), false);
  }
  for (const word of ['', null, undefined, 'true', '1', 'NOPE', 'off-line']) {
    assert.equal(isEnabled({ KHY_NL_PROVIDER: word }), true, `${String(word)} keeps it open`);
  }
  assert.equal(isEnabled({ KHY_NL_PROVIDER: 0 }), false);
  assert.equal(isEnabled({ KHY_NL_PROVIDER: false }), false);
  assert.equal(isEnabled(null), true, 'null env → raw null → treated as unset');
  assert.equal(isEnabled(0), false, 'the falsy env itself becomes the "0" literal');
  assert.equal(isEnabled('x'), true);
});

test('领域闸门是硬前提：没有供应商/密钥/模型/endpoint 引用一律不接管', () => {
  for (const s of ['添加一个功能', '列出当前目录文件', '设置闹钟', '添加会议', '帮我写个模型', '删除这行代码']) {
    assert.equal(resolve(s, ON), null, s);
  }
  assert.deepEqual(resolve('列出所有供应商', ON), { action: 'list', scope: 'all' });
  assert.deepEqual(resolve('查看已配置的模型', ON), { action: 'list', scope: 'all' });
  assert.deepEqual(resolve('有哪些模型可用', ON), { action: 'list', scope: 'all' });
  assert.deepEqual(resolve('list providers', ON), { action: 'list', scope: 'all' });
  assert.deepEqual(resolve('show my api keys', ON), { action: 'list', scope: 'all' });
});

test('add 需要 provider 与 apiKey 同时抓到，缺一不接管', () => {
  assert.deepEqual(resolve(`添加供应商 deepseek 的密钥 ${SK}`, ON), {
    action: 'add', provider: 'deepseek', apiKey: SK, model: '', endpoint: '',
  });
  assert.equal(resolve(`添加密钥 ${SK}`, ON), null, 'a key with no provider name is not a write intent');
  assert.equal(resolve('添加供应商 deepseek', ON), null, 'a provider with no key stays unhandled');
  assert.equal(resolve('设置 provider 为 x', ON), null);
  assert.deepEqual(resolve(`给 openai 添加 api key 为 ${SK}`, ON).provider, 'openai');
});

test('add 顺带抽出 model 与 endpoint，且只取第一个 key', () => {
  const r = resolve(`配置 provider: moonshot key sk-1234567890abcdef endpoint https://api.moonshot.cn/v1 模型 moonshot-v1-8k`, ON);
  assert.deepEqual(r, {
    action: 'add',
    provider: 'moonshot',
    apiKey: 'sk-1234567890abcdef',
    model: 'moonshot-v1-8k',
    endpoint: 'https://api.moonshot.cn/v1',
  });
  const first = resolve(`添加供应商 deepseek 的密钥是 ${SK} 而不是 sk-xyz987654321`, ON);
  assert.equal(first.apiKey, SK, 'the first sk- token wins');
  assert.deepEqual(resolve(`给 deepseek 添加密钥 ${SK} 模型 deepseek-chat endpoint https://api.deepseek.com`, ON), {
    action: 'add', provider: 'deepseek', apiKey: SK, model: 'deepseek-chat', endpoint: 'https://api.deepseek.com',
  });
});

test('四种 provider 措辞位置都能抽出名字（关键词后 / 给…添加 / …的密钥 前 / 裸 ASCII）', () => {
  for (const [text, provider] of [
    [`新增 渠道 test 密钥 ${SK}`, 'test'],
    [`注册 relay 的 apikey ${SK}`, 'relay'],
    [`添加 厂商 openrouter 的 key sk-or-v1-abcdefghijklmnop`, 'openrouter'],
    [`配置 provider 名为 abc 的 apikey ${SK}`, 'abc'],
    [`切换 deepseek 密钥 ${SK}`, 'deepseek'],
  ]) {
    assert.equal(resolve(text, ON).provider, provider, text);
  }
});

test('remove 判据最严：抓不到具体目标就不接管，动作词本身不算目标', () => {
  assert.deepEqual(resolve('删除供应商 deepseek', ON), {
    action: 'remove', target: 'deepseek', confirmed: false, removeKeys: false,
  });
  assert.equal(resolve('删除这个供应商', ON), null, '这个 is a stopword');
  assert.equal(resolve('删除 key', ON), null, 'key is a stopword');
  assert.equal(resolve('删除这行代码', ON), null);
  assert.deepEqual(resolve('remove provider openai', ON).target, 'openai');
  assert.deepEqual(resolve('移除 moonshot 的密钥', ON).target, 'moonshot');
});

test('remove 的 confirmed 与 removeKeys 只在显式措辞下为真', () => {
  assert.equal(resolve('删除 deepseek 渠道，确认', ON).confirmed, true);
  assert.equal(resolve('确认删除供应商 glm', ON).confirmed, true);
  assert.equal(resolve('删除供应商 deepseek', ON).confirmed, false);
  assert.equal(resolve('立即删掉 provider relay 并一起删除密钥', ON).removeKeys, true);
  assert.equal(resolve('删掉 glm 供应商的密钥', ON).removeKeys, false);
  assert.equal(resolve('删除 供应商 deepseek 的 密钥', ON).removeKeys, false, 'the key mention alone is not "delete keys too"');
});

test('KNOWN-DEFECT remove 抢在 add 之前，导致同句里的 add 目标被当成删除对象', () => {
  // Destructive priority is documented, but the target is the FIRST provider in the whole sentence,
  // so "add deepseek …; delete openai" schedules the wrong provider for deletion.
  const r = resolve(`添加供应商 deepseek 密钥 ${SK}；删除 openai 渠道`, ON);
  assert.deepEqual(r, { action: 'remove', target: 'deepseek', confirmed: false, removeKeys: false });
  assert.equal(r.target, 'deepseek', 'measured: not "openai"');
  // Alone, the same delete clause does target openai.
  assert.equal(resolve('删除 openai 渠道', ON).target, 'openai');
});

test('KNOWN-DEFECT provider/目标抽取会把英文填充词与 CJK 尾句当名字（停用词表只覆盖中文动作词）', () => {
  assert.equal(resolve(`update api key ${SK}`, ON).provider, 'update', 'the replace verb itself becomes the vendor');
  assert.equal(resolve('replace the key with sk-abcdef123456', ON).provider, 'the', 'an article becomes the vendor');
  assert.equal(resolve(`更换中转的密钥 ${SK}`, ON).provider, '的密钥', 'trailing CJK after 中转');
  assert.equal(resolve('去掉所有 token', ON).target, '所有', 'a scope word becomes the delete target');
  assert.equal(resolve('删除 供应商 名: zhipu 确认删除 连密钥', ON).target, '名', 'the 名 marker is captured instead of zhipu');
  assert.equal(resolve('删掉 glm 供应商并把密钥也删', ON).target, '并把密钥也删');
});

test('替换族在抓到 key 却没抓到 provider 时反问（needsProvider），普通 add 不反问', () => {
  assert.deepEqual(resolve(`替换密钥为 ${SK}`, ON), {
    action: 'add', provider: '', apiKey: SK, model: '', endpoint: '', needsProvider: true,
  });
  assert.deepEqual(resolve(`换成 x 的 api key ${SK}`, ON).needsProvider, true, 'a 1-char name survives 关键词后 but not 给…添加');
  assert.equal('needsProvider' in resolve(`添加供应商 deepseek 的密钥 ${SK}`, ON), false);
  assert.equal(resolve(`添加密钥 ${SK}`, ON), null, 'a plain add without a provider never asks back');
});

test('CJK 厂商别名表按最长串先匹配，把残缺中文名规整成 poolKey', () => {
  assert.equal(resolve(`换成智谱的密钥 ${SK}`, ON).provider, 'glm');
  assert.equal(resolve(`替换通义千问 apikey ${SK}`, ON).provider, 'qwen');
  assert.equal(resolve(`修改百度的密钥 ${SK}`, ON).provider, 'wenxin');
  assert.equal(resolve(`换成千问的密钥 ${SK}`, ON).provider, 'qwen');
  assert.equal(resolve(`更新 doubao 的 api key ${SK}`, ON).provider, 'doubao');
});

test('子门控 KHY_NL_PROVIDER_REPLACE 关掉后替换族/CJK 别名/反问三项全部短路', () => {
  const OFF = { KHY_NL_PROVIDER: 'true', KHY_NL_PROVIDER_REPLACE: 'off' };
  assert.equal(resolve(`换成智谱的密钥 ${SK}`, OFF), null, 'byte-identical to the pre-feature behaviour');
  assert.deepEqual(resolve(`添加供应商 deepseek 的密钥 ${SK}`, OFF), {
    action: 'add', provider: 'deepseek', apiKey: SK, model: '', endpoint: '',
  }, 'the plain add path is untouched');
  assert.deepEqual(resolve('列出所有供应商', OFF), { action: 'list', scope: 'all' });
  assert.deepEqual(resolve('删除供应商 deepseek', OFF).action, 'remove');
  for (const off of ['0', 'false', 'no', 'OFF']) {
    assert.equal(resolve(`换成智谱的密钥 ${SK}`, { KHY_NL_PROVIDER: 'true', KHY_NL_PROVIDER_REPLACE: off }), null);
  }
});

test('子门控与主门控的空串都读作开（与 isOffValue 族一致但与"显式空串=关"的门控不同）', () => {
  assert.notEqual(resolve(`换成智谱的密钥 ${SK}`, { KHY_NL_PROVIDER: 'true', KHY_NL_PROVIDER_REPLACE: '' }), null);
  assert.notEqual(resolve(`换成智谱的密钥 ${SK}`, { KHY_NL_PROVIDER: 'true', KHY_NL_PROVIDER_REPLACE: null }), null);
  assert.notEqual(resolve(`换成智谱的密钥 ${SK}`, { KHY_NL_PROVIDER: '' }), null, 'an empty main gate string also stays open');
  assert.equal(resolve(`换成智谱的密钥 ${SK}`, { KHY_NL_PROVIDER: 'off' }), null);
});

test('主门控关时 resolve 对同一文本恒 null', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(resolve(`添加供应商 deepseek 的密钥 ${SK}`, { KHY_NL_PROVIDER: off }), null);
    assert.equal(resolve('删除供应商 deepseek', { KHY_NL_PROVIDER: off }), null);
    assert.equal(resolve('列出所有供应商', { KHY_NL_PROVIDER: off }), null);
  }
});

test('长度上限 500 闭区间：500 内可解析，501 一律 null', () => {
  const base = `添加供应商 deepseek 的密钥 ${SK}`;
  const at500 = base + '。'.repeat(500 - base.length);
  assert.equal(at500.length, 500);
  assert.equal(resolve(at500, ON).provider, 'deepseek');
  assert.equal(resolve(`${at500}。`, ON), null);
  assert.equal(resolve(`${'x'.repeat(501)} 添加供应商 deepseek 密钥 ${SK}`, ON), null);
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

test('三种返回形状各有固定键集，add 的可选字段用空串而非 undefined', () => {
  const add = resolve(`添加供应商 deepseek 的密钥 ${SK}`, ON);
  assert.deepEqual(Object.keys(add), ['action', 'provider', 'apiKey', 'model', 'endpoint']);
  assert.equal(add.model, '');
  assert.equal(add.endpoint, '');
  const ask = resolve(`替换密钥为 ${SK}`, ON);
  assert.deepEqual(Object.keys(ask), ['action', 'provider', 'apiKey', 'model', 'endpoint', 'needsProvider']);
  assert.deepEqual(Object.keys(resolve('列出所有供应商', ON)), ['action', 'scope']);
  assert.deepEqual(Object.keys(resolve('删除供应商 deepseek', ON)), ['action', 'target', 'confirmed', 'removeKeys']);
});

test('解析不改动注入的 env，且每次返回新对象', () => {
  const env = { KHY_NL_PROVIDER: 'true', KEEP: 'me' };
  const a = resolve(`添加供应商 deepseek 的密钥 ${SK}`, env);
  const b = resolve(`添加供应商 deepseek 的密钥 ${SK}`, env);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  assert.deepEqual(env, { KHY_NL_PROVIDER: 'true', KEEP: 'me' });
});

test('只读 list 是 add 失败时的兜底出口（写意图降级为读，不会误写）', () => {
  // No key captured, so the add branch declines and the list branch takes over.
  assert.deepEqual(resolve('列出密钥 sk-abcdef123456 的模型', ON), { action: 'list', scope: 'all' });
  assert.deepEqual(resolve('查看模型列表 并添加 供应商 a 密钥 sk-abcdef123456', ON).action, 'add', 'with a real name the write branch wins');
  assert.equal(resolve('帮我配置一下模型', ON), null, 'no list verb either → decline entirely');
});
