'use strict';

// Co-located contract tests for nlConfigResolver.js (纯叶子 NL → 能力开关意图)。
// Measured via .khyos/tmp/probeConfig.js. Zero-IO, but resolve/route/isEnabled default to the real
// process.env, so every call injects an env object. No test here writes anything.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isEnabled,
  CAPABILITIES,
  ON_VALUE,
  OFF_VALUE,
  resolveConfigIntent,
  buildEnvPatch,
  describeCapabilities,
  findCapability,
  buildConfigDirective,
  routeConfigIntent,
} = require('./nlConfigResolver');

const ON = { KHY_NL_CONFIG: 'true' };
const gt = (s, env) => resolveConfigIntent(s, env || ON);

test('能力注册表是单一真源：50 项、id 与 envKey 双双唯一、每项四字段', () => {
  assert.equal(CAPABILITIES.length, 50);
  assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, 50);
  assert.equal(new Set(CAPABILITIES.map((c) => c.envKey)).size, 50);
  for (const c of CAPABILITIES) {
    assert.deepEqual(Object.keys(c), ['id', 'envKey', 'summary', 'aliases'], c.id);
    assert.match(c.envKey, /^KHY_[A-Z0-9_]+$/, c.id);
    assert.equal(Array.isArray(c.aliases) && c.aliases.length > 0, true, c.id);
    assert.equal(c.aliases.every((a) => typeof a === 'string' && a.trim() !== ''), true, c.id);
  }
  assert.deepEqual([ON_VALUE, OFF_VALUE], ['true', 'off']);
});

test('门控默认开，仅 CANON 四词关；空串读作开、数字 0 读作关', () => {
  assert.equal(isEnabled({}), true);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(isEnabled({ KHY_NL_CONFIG: word }), false, `${word} closes`);
  }
  for (const word of ['', null, undefined, 'true', '1', 'NOPE']) {
    assert.equal(isEnabled({ KHY_NL_CONFIG: word }), true, `${String(word)} stays open`);
  }
  assert.equal(isEnabled({ KHY_NL_CONFIG: 0 }), false);
  assert.equal(isEnabled({ KHY_NL_CONFIG: false }), false);
  assert.equal(isEnabled(null), true);
  assert.equal(isEnabled(0), false, 'a falsy env is stringified to "0"');
  assert.equal(isEnabled('x'), true);
});

test('中文与英文动作词 + 别名命中同一个能力开关', () => {
  assert.deepEqual(gt('开启地面真值'), {
    kind: 'toggle', capabilityId: 'ground-truth', envKey: 'KHY_GROUND_TRUTH', action: 'on', value: 'true',
    summary: '地面真值(算术/进制用精确有理数算出,禁模型心算)',
  });
  assert.equal(gt('关闭地面真值').value, OFF_VALUE);
  assert.equal(gt('把流式渲染关掉').capabilityId, 'streaming-md');
  assert.equal(gt('enable ground truth').action, 'on');
  assert.equal(gt('disable streaming markdown').action, 'off');
  assert.equal(gt('turn on 省 token').envKey, 'KHY_RTK_MODE');
  assert.equal(gt('开启 token 节省').capabilityId, 'rtk', 'a second alias reaches the same row');
});

test('动作与能力缺一律不接管（零假阳性）', () => {
  assert.equal(gt('地面真值'), null, 'the capability noun without an action verb');
  assert.equal(gt('开启一下'), null, 'the action without any capability');
  assert.equal(gt('开启 一个不存在的能力'), null);
  assert.equal(gt('今天天气不错'), null);
});

test('裸 KHY_ 键也算能力引用：已注册的回填 id，未注册的回显键名', () => {
  assert.deepEqual(gt('开启 KHY_GROUND_TRUTH'), {
    kind: 'toggle', capabilityId: 'ground-truth', envKey: 'KHY_GROUND_TRUTH', action: 'on', value: 'true',
    summary: '地面真值(算术/进制用精确有理数算出,禁模型心算)',
  });
  assert.deepEqual(gt('关闭 KHY_NOT_REGISTERED'), {
    kind: 'toggle', capabilityId: null, envKey: 'KHY_NOT_REGISTERED', action: 'off', value: 'off', summary: 'KHY_NOT_REGISTERED',
  });
});

test('显式 raw 赋值优先于别名匹配，已知键转成 toggle、未知键保持 raw', () => {
  assert.equal(gt('把 KHY_GROUND_TRUTH=off').capabilityId, 'ground-truth');
  assert.equal(gt('把 KHY_GROUND_TRUTH=off').action, 'off');
  assert.equal(gt('把 KHY_GROUND_TRUTH 设为 off').action, 'off');
  assert.equal(gt('把 KHY_GROUND_TRUTH 设置为 true').value, 'true');
  assert.deepEqual(gt('把 KHY_FOO 设为 bar'), { kind: 'raw', envKey: 'KHY_FOO', value: 'bar' });
  assert.deepEqual(gt('KHY_FOO=bar'), { kind: 'raw', envKey: 'KHY_FOO', value: 'bar' });
  assert.equal(gt('khy_foo=bar'), null, 'the assign pattern is upper-case only');
});

test('raw 赋值把 FALSY 字面值读成 off，其它值一律 on 且原样保留 value', () => {
  for (const [phrase, action] of [['0', 'off'], ['no', 'off'], ['false', 'off'], ['off', 'off']]) {
    const r = gt(`把 KHY_RTK_MODE 改为 ${phrase}`);
    assert.equal(r.action, action, phrase);
    assert.equal(r.value, phrase, 'value keeps what the user typed');
  }
  const maybe = gt('把 KHY_RTK_MODE 置为 maybe');
  assert.deepEqual([maybe.action, maybe.value], ['on', 'maybe']);
  assert.equal(gt('把 KHY_RTK_MODE 改成 no').envKey, 'KHY_RTK_MODE');
});

test('开/关词同现时取"最后出现者"', () => {
  assert.equal(gt('开启并关闭地面真值').action, 'off');
  assert.equal(gt('关闭并开启地面真值').action, 'on');
});

test('KNOWN-DEFECT 否定式措辞被反向解析：别再开启/关闭而不是打开 都判成 on', () => {
  // _detectAction claims "关优先" and the header lists 别再开启… as the motivating off case,
  // yet the last-occurrence tie-break lands on the verb inside the negation.
  assert.deepEqual(gt('别再开启流式渲染'), {
    kind: 'toggle', capabilityId: 'streaming-md', envKey: 'KHY_STREAMING_MD', action: 'on', value: 'true',
    summary: '流式 Markdown 渲染(逐结构提交,末句完整)',
  });
  assert.equal(gt('不要再打开流式渲染').action, 'on', 'the user means stop, the resolver says start');
  assert.equal(gt('关闭而不是打开流式渲染').action, 'on', 'inverted');
  assert.equal(gt('打开而不是关闭流式渲染').action, 'off', 'inverted the other way');
});

test('khy 自注入的 [SYSTEM: 指令一律不解析，但守卫只锚定句首', () => {
  assert.equal(gt('[SYSTEM: 目标是持久目标，请清除]'), null);
  assert.equal(gt('  [SYSTEM: x] 开启地面真值'), null, 'leading whitespace still counts as injected');
  assert.equal(gt('开启地面真值 [SYSTEM: x]').action, 'on', 'a mid-string marker disables the guard');
});

test('并列命中多个能力时返回 ambiguous 候选（子门 KHY_NL_CONFIG_DISAMBIGUATE 默认开）', () => {
  const r = gt('开启完成推送通知');
  assert.equal(r.kind, 'ambiguous');
  assert.equal(r.action, 'on');
  assert.deepEqual(r.candidates.map((c) => c.id), ['push-notify', 'push-on-done']);
  assert.deepEqual(Object.keys(r.candidates[0]), ['id', 'envKey', 'summary']);
  assert.match(r.summary, /^多个能力都匹配到了\(/);
  assert.equal('envKey' in r, false, 'an ambiguous intent carries no single key');
});

test('子门关掉后逐字节回退旧的 single-best 猜测', () => {
  const off = { KHY_NL_CONFIG: 'true', KHY_NL_CONFIG_DISAMBIGUATE: 'off' };
  assert.deepEqual(gt('开启完成推送通知', off), {
    kind: 'toggle', capabilityId: 'push-notify', envKey: 'KHY_PUSH_NOTIFY', action: 'on', value: 'true',
    summary: CAPABILITIES.find((c) => c.id === 'push-notify').summary,
  });
  for (const w of ['0', 'false', 'no', 'OFF']) {
    assert.equal(gt('开启完成推送通知', { KHY_NL_CONFIG: 'true', KHY_NL_CONFIG_DISAMBIGUATE: w }).kind, 'toggle');
  }
  assert.equal(gt('开启完成推送通知', { KHY_NL_CONFIG: 'true', KHY_NL_CONFIG_DISAMBIGUATE: '' }).kind, 'ambiguous', 'empty sub-gate string stays open');
});

test('主门控关时 resolve 恒 null；空串门控仍开', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(gt('开启地面真值', { KHY_NL_CONFIG: off }), null);
    assert.equal(gt('把 KHY_FOO 设为 bar', { KHY_NL_CONFIG: off }), null);
  }
  assert.equal(gt('开启地面真值', { KHY_NL_CONFIG: '' }).kind, 'toggle');
});

test('垃圾输入一律 null 且绝不抛（契约 fail-soft）', () => {
  for (const junk of [null, undefined, '', '   ', 0, 123, true, false, [], {}, new Set()]) {
    assert.equal(gt(junk), null, `junk ${String(junk)}`);
  }
  assert.doesNotThrow(() => gt({ toString() { throw new Error('boom'); } }));
  assert.equal(gt({ toString() { throw new Error('boom'); } }), null);
});

test('解析不设长度上限（兄弟叶子截 500 / 守卫叶截 4000）', () => {
  assert.equal(gt(`${'x'.repeat(20000)} 开启地面真值`).kind, 'toggle');
  assert.equal(gt('开启地面真值'.repeat(200)).capabilityId, 'ground-truth');
});

test('buildEnvPatch：value 优先，其次按 action，缺位给 true；空 envKey 得到零形状', () => {
  assert.deepEqual(buildEnvPatch(null), { envMap: {}, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch(undefined), { envMap: {}, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({}), { envMap: {}, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: '' }), { envMap: {}, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', value: 'off' }), { envMap: { KHY_X: 'off' }, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', action: 'off' }), { envMap: { KHY_X: 'off' }, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', action: 'on' }), { envMap: { KHY_X: 'true' }, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X' }), { envMap: { KHY_X: 'true' }, unsetKeys: [] });
});

test('buildEnvPatch 会把 value 字符串化，空串与 0 也照样写进补丁', () => {
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', value: '' }), { envMap: { KHY_X: '' }, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', value: 0 }), { envMap: { KHY_X: '0' }, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', value: false }), { envMap: { KHY_X: 'false' }, unsetKeys: [] });
  assert.deepEqual(buildEnvPatch({ envKey: 'KHY_X', value: null, action: 'off' }), { envMap: { KHY_X: 'off' }, unsetKeys: [] });
  assert.notEqual(buildEnvPatch(null), buildEnvPatch(null), 'a fresh shape per call');
});

test('buildConfigDirective 总是先给五行原则指令，再按 kind 追加一行', () => {
  const base = buildConfigDirective(null);
  assert.equal(base.startsWith('[SYSTEM:'), true);
  assert.equal(base.split('\n').length, 5);
  assert.equal(base.includes('用户是最高权限'), true);
  assert.match(buildConfigDirective({ kind: 'zzz' }), /用户是最高权限/);
  assert.equal(buildConfigDirective({ kind: 'zzz' }), base, 'an unknown kind adds nothing');
  const toggle = buildConfigDirective(gt('开启地面真值'));
  assert.equal(toggle.split('\n').length, 6);
  assert.equal(toggle.includes('capability=ground-truth, state=on'), true);
  assert.equal(toggle.includes('开启能力「'), true);
});

test('指令对 raw 与 ambiguous 两种意图分别给出执行/澄清话术', () => {
  const raw = buildConfigDirective({ kind: 'raw', envKey: 'KHY_FOO', value: 'bar' });
  assert.equal(raw.includes('把 KHY_FOO 设为 bar'), true);
  const amb = buildConfigDirective(gt('开启完成推送通知'));
  assert.equal(amb.includes('1. '), true);
  assert.equal(amb.includes('KHY_PUSH_ON_DONE'), true);
  assert.equal(amb.includes('宁可多问一句'), true);
  assert.equal(amb.includes('不要调用 Configure'), true, 'the ambiguity branch overrides the act-immediately principle');
});

test('缝入口没有意图也注入原则指令，门控关才整体 null', () => {
  const empty = routeConfigIntent({ text: '你好', env: ON });
  assert.deepEqual(Object.keys(empty), ['directive', 'intent']);
  assert.equal(empty.intent, null);
  assert.equal(empty.directive.split('\n').length, 5);
  const hit = routeConfigIntent({ text: '开启地面真值', env: ON });
  assert.equal(hit.intent.capabilityId, 'ground-truth');
  assert.equal(hit.directive.includes('capability=ground-truth'), true);
  assert.equal(routeConfigIntent({ text: '开启地面真值', env: { KHY_NL_CONFIG: 'off' } }), null);
});

test('KNOWN-DEFECT 缝入口没有 try/catch：null opts 与抛异常的 env getter 直接把异常抛给调用方', () => {
  assert.throws(() => routeConfigIntent(null), TypeError);
  assert.throws(() => routeConfigIntent({ text: '开启地面真值', get env() { throw new Error('trap'); } }), Error);
  // Sibling seams (routeActionIntent / routePhilosophyIntent) swallow the very same inputs.
  // Non-object opts are tolerated (they just carry no text/env), which we assert env-independently.
  const hostGated = isEnabled(process.env);
  const fromString = routeConfigIntent('x');
  if (hostGated) {
    assert.equal(fromString.intent, null, 'a string opts carries no text');
    assert.deepEqual(routeConfigIntent(0).directive, buildConfigDirective(null));
  }
});

test('describeCapabilities 是深一层副本，findCapability 却交出注册表活对象', () => {
  const listed = describeCapabilities();
  assert.equal(listed.length, 50);
  assert.notEqual(listed, describeCapabilities());
  assert.notEqual(listed[0], CAPABILITIES[0]);
  assert.notEqual(listed[0].aliases, CAPABILITIES[0].aliases, 'even the alias array is copied');
  const live = findCapability('ground-truth');
  assert.equal(live === CAPABILITIES.find((c) => c.id === 'ground-truth'), true, 'mutable registry reference escapes');
});

test('findCapability 支持 id / envKey / 别名三种查法，未知一律 null', () => {
  assert.equal(findCapability('ground-truth').id, 'ground-truth');
  assert.equal(findCapability('KHY_GROUND_TRUTH').id, 'ground-truth');
  assert.equal(findCapability('地面真值').id, 'ground-truth');
  assert.equal(findCapability(' GROUND TRUTH ').id, 'ground-truth', 'the alias leg is case-folded');
  assert.equal(findCapability('GROUND-TRUTH').id, 'ground-truth', 'the id leg misses but the alias leg catches it');
  for (const junk of [null, undefined, '', 0, {}, 'nonsense', 50]) {
    assert.equal(findCapability(junk), null, `junk ${String(junk)}`);
  }
});

test('解析不改写注册表也不改动注入的 env', () => {
  const before = JSON.stringify(CAPABILITIES.map((c) => [c.id, c.envKey, c.aliases.length]));
  const env = { KHY_NL_CONFIG: 'true', KEEP: 'me' };
  gt('开启地面真值', env);
  routeConfigIntent({ text: '关闭地面真值', env });
  buildConfigDirective(gt('开启完成推送通知', env));
  assert.equal(JSON.stringify(CAPABILITIES.map((c) => [c.id, c.envKey, c.aliases.length])), before);
  assert.deepEqual(env, { KHY_NL_CONFIG: 'true', KEEP: 'me' });
});
