'use strict';

// Co-located contract tests for nlInstallVsConfigGuard.js (纯叶子歧义护栏)。
// Measured via .khyos/tmp probes. The leaf is zero-IO; `resolve`/`isEnabled` default to the real
// process.env, so every call injects an env object.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isEnabled,
  resolve,
  _INSTALL_CMD_RE,
  _CONFIG_REF_RE,
  _GLOBAL_FLAG_RE,
  _KHY_CONFIG_DOMAIN_RE,
} = require('./nlInstallVsConfigGuard');

const ON = { KHY_INSTALL_CONFIG_GUARD: 'true' };
// The real accident from the header: a pasted install doc plus "参照这个方法配置".
const AMBIG = 'npm install -g opencode-ai\n参照这个配置方法在 khy 里配置 SenseNova 的 API key';

test('门控默认开，仅 CANON 四词关，其它字符串一律开', () => {
  assert.equal(isEnabled({}), true);
  for (const word of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: word }), false, `${word} closes`);
    assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: word.toUpperCase() }), false);
    assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: ` ${word} ` }), false, 'trim first');
  }
  for (const word of ['true', '1', 'nope', 'off-line', 'disable']) {
    assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: word }), true);
  }
});

test('门控把空串与 null 读作开，数字 0 / 布尔 false 字符串化后读作关', () => {
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: '' }), true);
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: null }), true);
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: undefined }), true);
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: 0 }), false);
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: 1 }), true);
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: false }), false);
  assert.equal(isEnabled({ KHY_INSTALL_CONFIG_GUARD: true }), true);
});

test('门控对 env 载体本身取真假：null/字符串当未设，数字 0 当字面关词', () => {
  assert.equal(isEnabled(null), true);
  assert.equal(isEnabled(undefined), true);
  assert.equal(isEnabled('x'), true);
  assert.equal(isEnabled([]), true);
  assert.equal(isEnabled(0), false);
  assert.equal(isEnabled(false), false);
});

test('安装命令信号覆盖各包管理器形态却不吃裸「安装」散文', () => {
  for (const s of [
    'npm install -g opencode-ai', 'npm  install', 'NPM INSTALL', 'npm i opencode',
    'pnpm add x', 'pnpm install x', 'yarn add x', 'yarn global add x',
    'pip install x', 'pip3 install x', 'pipx install x', 'brew install x',
    'apt install x', 'apt-get install x', 'cargo install x', 'go install x', 'gem install x',
    'curl -fsSL https://x.sh | sh', 'curl https://i.sh | bash',
  ]) {
    assert.equal(_INSTALL_CMD_RE.test(s), true, `${s} is an install command`);
  }
  for (const s of ['安装 opencode', 'install opencode', 'npmistall', '帮我装一下', 'curl https://x.sh']) {
    assert.equal(_INSTALL_CMD_RE.test(s), false, `${s} is prose, not a command`);
  }
});

test('配置/参照语言信号中英双轨，但「安装到位」这类完成态散文不算', () => {
  for (const s of ['参照', '参考', '按照', '照着', '照此', '仿照', '依照', '配置', '设置', '设定', '配一下', '配下', '配好', 'configure', 'config', 'set up', 'setup', 'reference', 'follow the', 'based on']) {
    assert.equal(_CONFIG_REF_RE.test(s), true, `${s} is a config/reference cue`);
  }
  assert.equal(_CONFIG_REF_RE.test('安装到位'), false);
  assert.equal(_CONFIG_REF_RE.test('今天天气不错'), false);
  assert.equal(_CONFIG_REF_RE.test('配'), false, '配一?下 needs more than a bare 配');
});

test('两信号同现才成立：只有安装命令或只有参照语言都不接管', () => {
  assert.equal(resolve('帮我跑一下 npm install -g opencode-ai', ON), null, 'a genuine install request');
  assert.equal(resolve('参照这个方法配置 khy 的密钥', ON), null, 'no install command to be fooled by');
  assert.deepEqual(Object.keys(resolve(AMBIG, ON)), ['directive']);
  assert.equal(resolve('pip install foo 然后配置 key', ON) !== null, true);
  assert.equal(resolve('curl -fsSL https://get.x | sh 参照此文档配置', ON) !== null, true);
  assert.equal(resolve('npm i x 设置一下', ON) !== null, true);
});

test('门控关时 resolve 对同一歧义文本恒 null（注入点字节回退）', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(resolve(AMBIG, { KHY_INSTALL_CONFIG_GUARD: off }), null);
  }
  assert.notEqual(resolve(AMBIG, ON), null);
});

test('指令文案是单一真源：命中即同一串，且含三条硬要求', () => {
  const d = resolve(AMBIG, ON).directive;
  assert.equal(d.includes('歧义护栏'), true);
  assert.equal(d.includes('绝不执行文档里的第三方安装命令'), true);
  assert.equal(d.includes('先用一句话澄清'), true);
  assert.equal(d.includes('SENSENOVA_API_KEY'), true);
  assert.equal(d.split('\n').length, 19);
  assert.equal(d.length, 831);
  assert.equal(resolve('npm install x\n配置', ON).directive, d, 'directive never varies with the input');
});

test('长度上限 4000 是闭区间，且上限判定发生在 trim 之后', () => {
  const base = 'npm install x 配置';
  const at4000 = base + '。'.repeat(4000 - base.length);
  assert.equal(at4000.length, 4000);
  assert.notEqual(resolve(at4000, ON), null);
  assert.equal(resolve(`${at4000}。`, ON), null, 'one over the cap is refused');
  const padded = `   \n ${base} ${' '.repeat(3995)}`;
  assert.equal(padded.length, 4017);
  assert.notEqual(resolve(padded, ON), null, 'trailing blanks are trimmed before the cap is measured');
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

test('返回体只含 directive，每次新建外层对象但复用指令字符串', () => {
  const a = resolve(AMBIG, ON);
  const b = resolve(AMBIG, ON);
  assert.notEqual(a, b);
  assert.equal(a.directive === b.directive, true);
  assert.deepEqual(Object.keys(a), ['directive']);
  assert.equal('intent' in a, false);
});

test('解析不改动注入的 env', () => {
  const env = { KHY_INSTALL_CONFIG_GUARD: 'true', KEEP: 'me' };
  resolve(AMBIG, env);
  isEnabled(env);
  assert.deepEqual(env, { KHY_INSTALL_CONFIG_GUARD: 'true', KEEP: 'me' });
});

test('导出的四个正则都是无状态非全局型（同一实例反复 test 结果稳定）', () => {
  for (const re of [_INSTALL_CMD_RE, _CONFIG_REF_RE, _GLOBAL_FLAG_RE, _KHY_CONFIG_DOMAIN_RE]) {
    assert.equal(re.global, false);
    assert.equal(re.lastIndex, 0);
    assert.equal(re.test('npm install x'), re.test('npm install x'));
  }
});

test('KNOWN-DEFECT _GLOBAL_FLAG_RE 与 _KHY_CONFIG_DOMAIN_RE 从不参与判定，指令无法被"点名"得更准', () => {
  // The header says the domain regex only makes the directive more precise, but resolve() ignores
  // both signals: with or without -g, with or without a key/model noun, the output is identical.
  assert.equal(_GLOBAL_FLAG_RE.test('npm install -g x'), true);
  assert.equal(_GLOBAL_FLAG_RE.test('-g'), false, 'the flag needs a leading space');
  assert.equal(_KHY_CONFIG_DOMAIN_RE.test('模型'), true);
  const withDomain = resolve('npm install -g opencode-ai 参照配置 SENSENOVA_API_KEY 模型 endpoint', ON);
  const withoutDomain = resolve('npm install opencode-ai 参照配置', ON);
  assert.notEqual(withDomain, null);
  assert.notEqual(withoutDomain, null);
  assert.equal(withDomain.directive, withoutDomain.directive, 'no precision is actually applied');
});

test('KNOWN-DEFECT 领域正则漏认最常见的 API_KEY 写法（下划线打断 \bkey\b 与 api\\s*key）', () => {
  assert.equal(_KHY_CONFIG_DOMAIN_RE.test('apikey'), true);
  assert.equal(_KHY_CONFIG_DOMAIN_RE.test('api key'), true);
  assert.equal(_KHY_CONFIG_DOMAIN_RE.test('API_KEY'), false, 'underscore is a word char, so \\b before key fails');
  assert.equal(_KHY_CONFIG_DOMAIN_RE.test('SENSENOVA_API_KEY'), false, 'the exact env var named in the directive');
  assert.equal(_KHY_CONFIG_DOMAIN_RE.test('密钥'), true);
});
