'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { validateHooksConfig, normalizeHook } = require('./hookConfigSchema.js');
const { HOOK_EVENTS } = require('./hookRegistry.js');

// Mirrors the 11 events the registry treats as valid (hookConfigSchema.js:22).
const ALL_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PrePrompt', 'PostResponse', 'PreCompact',
  'PostCompact', 'Stop', 'SubAgentStart', 'SubAgentEnd', 'ToolPermission', 'PromptSection',
];

describe('validateHooksConfig — 顶层形状归一', () => {
  test('裸数组与对象包都接受，且只认得 HOOK_EVENTS 里的事件', () => {
    assert.equal(validateHooksConfig([{ event: 'Stop', command: 'echo hi' }]).valid, true);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'PreToolUse', command: 'x' }] }).valid, true);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'NotAnEvent', command: 'x' }] }).valid, false);
  });

  test('HOOK_EVENTS 镜像与注册表真源逐字一致（两侧漂移即红）', () => {
    assert.deepEqual([...HOOK_EVENTS].sort(), [...ALL_EVENTS].sort());
    assert.equal(HOOK_EVENTS.length, 11);
  });

  test('非对象入参一律判不合，且不抛', () => {
    for (const bad of [null, undefined, 0, -1, NaN, '', 'hooks', true, false, () => {}, Symbol('s')]) {
      const res = validateHooksConfig(bad);
      assert.equal(res.valid, false, `must reject ${String(bad)}`);
      assert.deepEqual(res.errors, ['config must be an object or array']);
      assert.ok(Array.isArray(res.warnings));
    }
  });

  test('裸数组不带 version 不报 warning，对象包缺 version 报 warning', () => {
    assert.deepEqual(validateHooksConfig([{ event: 'Stop', command: 'x' }]).warnings, []);
    assert.equal(validateHooksConfig({ hooks: [] }).warnings.length, 1);
    assert.match(validateHooksConfig({ hooks: [] }).warnings[0], /missing version/);
  });

  test('version 只接受数字，字符串/布尔/null 均报错', () => {
    assert.equal(validateHooksConfig({ version: '1', hooks: [] }).valid, false);
    assert.match(validateHooksConfig({ version: '1', hooks: [] }).errors[0], /version must be a number, got string/);
    assert.equal(validateHooksConfig({ version: true, hooks: [] }).valid, false);
    // null is typeof 'object', not undefined — the guard only rejects non-number types.
    assert.equal(validateHooksConfig({ version: null, hooks: [] }).valid, false);
    assert.equal(validateHooksConfig({ version: 0, hooks: [] }).valid, true);
    assert.equal(validateHooksConfig({ version: 1.5, hooks: [] }).valid, true);
  });

  test('hooks 不是数组时报 hooks must be an array，元素不是对象时报 must be an object', () => {
    assert.match(validateHooksConfig({ version: 1, hooks: 'x' }).errors.join(), /hooks must be an array/);
    assert.match(validateHooksConfig({ version: 1, hooks: {} }).errors.join(), /hooks must be an array/);
    assert.deepEqual(validateHooksConfig({ version: 1, hooks: [null] }).errors, ['hooks[0]: must be an object']);
    assert.deepEqual(validateHooksConfig({ version: 1, hooks: ['x'] }).errors, ['hooks[0]: must be an object']);
    // An array element survives the `typeof === 'object'` gate, so it is reported
    // as a missing event plus a missing command.
    assert.deepEqual(validateHooksConfig({ version: 1, hooks: [[]] }).errors, [
      'hooks[0]: missing required field "event"',
      'hooks[0]: command-type hook requires a non-empty "command" string',
    ]);
  });

  test('带 source 的元素用 source 当错误标签，缺省用下标', () => {
    assert.deepEqual(
      validateHooksConfig({ version: 1, hooks: [{ source: 'myHook', command: 'x' }] }).errors,
      ['myHook: missing required field "event"']
    );
    assert.match(validateHooksConfig({ version: 1, hooks: [{ command: 'x' }] }).errors[0], /^hooks\[0\]:/);
  });

  test('event 非法时报出不合法事件名和合法清单', () => {
    const res = validateHooksConfig({ version: 1, hooks: [{ event: 'Bogus', command: 'x' }] });
    assert.equal(res.valid, false);
    assert.match(res.errors[0], /event "Bogus" not in HOOK_EVENTS/);
    assert.match(res.errors[0], /PromptSection/);
  });

  test('disabled 数组只收字符串，数字/null/对象均报错', () => {
    assert.equal(validateHooksConfig({ version: 1, hooks: [], disabled: ['a', 'b'] }).valid, true);
    const res = validateHooksConfig({ version: 1, hooks: [], disabled: ['a', 1, null, {}] });
    assert.equal(res.valid, false);
    assert.deepEqual(res.errors, [
      'disabled[1]: must be a string',
      'disabled[2]: must be a string',
      'disabled[3]: must be a string',
    ]);
    assert.match(validateHooksConfig({ version: 1, hooks: [], disabled: 'a' }).errors.join(), /disabled must be an array/);
  });

  test('pattern 给坏正则时报错，好正则放行（空串会被 forEach 的 undefined 判定跳过）', () => {
    assert.match(
      validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', pattern: '(' }] }).errors.join(),
      /pattern is not a valid RegExp/
    );
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', pattern: '^Bash$' }] }).valid, true);
    // '' is a compilable pattern, so it is accepted (not the same as "absent").
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', pattern: '' }] }).valid, true);
  });

  test('priority 必须是非负整数，enabled 必须是布尔', () => {
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', priority: 0 }] }).valid, true);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', priority: -1 }] }).valid, false);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', priority: 1.5 }] }).valid, false);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', priority: '3' }] }).valid, false);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', enabled: false }] }).valid, true);
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', enabled: 'no' }] }).valid, false);
  });

  test('timeout 非正数报错（0 / -1 / 字符串 / null）', () => {
    for (const t of [0, -1, '5000', [], null]) {
      const res = validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', timeout: t }] });
      assert.equal(res.valid, false, `timeout ${JSON.stringify(t)} must be rejected`);
      assert.match(res.errors.join(), /timeout must be a positive number/);
    }
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', timeout: 1 }] }).valid, true);
  });

  test('command 缺失且无 handler 时报 command-type hook requires…', () => {
    const res = validateHooksConfig({ version: 1, hooks: [{ event: 'Stop' }] });
    assert.equal(res.valid, false);
    assert.match(res.errors[0], /requires a non-empty "command" string/);
    // handler 是函数即视为代码级 hook，不需要 command。
    assert.equal(validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', handler() {} }] }).valid, true);
  });

  test('KNOWN-DEFECT: NaN 与 Infinity 被当成合法 timeout（hookConfigSchema.js:114）', () => {
    // `typeof NaN === 'number'` is true and `NaN <= 0` is false, so the positivity
    // guard accepts a timeout that no timer can ever honour. Infinity behaves the
    // same way. The defect propagates: normalizeHook keeps the NaN verbatim.
    const nan = validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', timeout: NaN }] });
    assert.equal(nan.valid, true);
    assert.deepEqual(nan.errors, []);
    const inf = validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: 'x', timeout: Infinity }] });
    assert.equal(inf.valid, true);
    assert.ok(Number.isNaN(normalizeHook({ event: 'Stop', command: 'x', timeout: NaN }).timeout));
  });

  test('KNOWN-DEFECT: 纯空白 command 被判合法（hookConfigSchema.js:93-102）', () => {
    // The first guard uses `!h.command.trim()` to detect "no command", but the
    // fallback error branch tests the untrimmed `!h.command` — so '   ' slips
    // through as valid and normalizeHook hands the whitespace back as the command.
    const res = validateHooksConfig({ version: 1, hooks: [{ event: 'Stop', command: '   ' }] });
    assert.equal(res.valid, true);
    assert.equal(normalizeHook({ event: 'Stop', command: '   ' }).command, '   ');
  });

  test('event 为 0 / false / 空串时报「缺 event」（falsy 归入缺失，含合法的 0 也丢失原因文本）', () => {
    for (const ev of [0, false, '']) {
      const res = validateHooksConfig({ version: 1, hooks: [{ event: ev, command: 'x' }] });
      assert.equal(res.valid, false);
      assert.match(res.errors[0], /missing required field "event"/);
    }
  });
});

describe('normalizeHook — 归一化消费形状', () => {
  test('合法 command hook 补齐注册表要的八个字段', () => {
    assert.deepEqual(normalizeHook({ event: 'PreToolUse', command: 'ls' }), {
      event: 'PreToolUse',
      type: 'command',
      command: 'ls',
      handler: null,
      pattern: undefined,
      timeout: 10000,
      priority: 100,
      source: 'config',
      enabled: true,
    });
  });

  test('已给的 timeout / priority / source / enabled 原样保留（0 与 false 不被吞）', () => {
    const n = normalizeHook({ event: 'Stop', command: 'x', timeout: 1, priority: 0, source: 'mine', enabled: false });
    assert.equal(n.timeout, 1);
    assert.equal(n.priority, 0);
    assert.equal(n.source, 'mine');
    assert.equal(n.enabled, false);
  });

  test('不合 schema 的入参返回 null（含垃圾入参）', () => {
    assert.equal(normalizeHook(null), null);
    assert.equal(normalizeHook(undefined), null);
    assert.equal(normalizeHook({}), null);
    assert.equal(normalizeHook('PreToolUse'), null);
    assert.equal(normalizeHook(0), null);
    assert.equal(normalizeHook([]), null);
    assert.equal(normalizeHook({ event: 'Bogus', command: 'x' }), null);
  });

  test('KNOWN-DEFECT: handler 型 hook 归一后 command/handler 双 null，成为永不执行的空壳（hookConfigSchema.js:158-168）', () => {
    // validateHooksConfig accepts a function handler, then normalizeHook hard-codes
    // `type: 'command'`, `command: null`, `handler: null` — the one piece of the
    // input that made it valid is dropped on the floor. Registry-side such a hook
    // would be rejected as "missing command"; here it is returned as if normalized.
    const n = normalizeHook({ event: 'PreToolUse', handler() { return { action: 'block' }; } });
    assert.notEqual(n, null);
    assert.equal(n.type, 'command');
    assert.equal(n.command, null);
    assert.equal(n.handler, null);
  });
});
