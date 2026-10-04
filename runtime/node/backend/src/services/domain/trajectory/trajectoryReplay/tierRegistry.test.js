'use strict';

/**
 * tierRegistry.test.js — 钉死工具回放分层契约：三档冻结常量、归一化（小写并剥空下画线短横）、
 * FILE 集派生自 _writeToolNames + 两个多文件写工具、未知工具保守收敛到 SHELL、分类 total 不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const mod = require('./tierRegistry');
const { WRITE_TOOL_NAMES } = require('../../../../tools/_writeToolNames');

test('导出恰为 TIER/三个工具集/normalize/classify/effectiveTier 共 7 个符号', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'FILE_TOOLS',
    'NETWORK_AI_TOOLS',
    'SHELL_TOOLS',
    'TIER',
    'classify',
    'effectiveTier',
    'normalize',
  ]);
});

test('TIER 三档常量恰为 FILE/SHELL/NETWORK_AI 且整体冻结', () => {
  assert.deepStrictEqual({ ...mod.TIER }, { FILE: 'FILE', SHELL: 'SHELL', NETWORK_AI: 'NETWORK_AI' });
  assert.ok(Object.isFrozen(mod.TIER));
});

test('FILE_TOOLS 非空且恰为捕获白名单加 applypatch 与 scaffoldfiles（派生自单一真源）', () => {
  // 反空转：上游白名单本身必须非空，否则派生集退化为两元素
  assert.ok(WRITE_TOOL_NAMES.size > 0 || WRITE_TOOL_NAMES.length > 0);
  assert.strictEqual(mod.FILE_TOOLS.size, new Set([...WRITE_TOOL_NAMES, 'applypatch', 'scaffoldfiles']).size);
  for (const n of WRITE_TOOL_NAMES) {
    assert.ok(mod.FILE_TOOLS.has(n), `白名单项 ${n} 必须在 FILE_TOOLS`);
  }
  assert.ok(mod.FILE_TOOLS.has('applypatch'));
  assert.ok(mod.FILE_TOOLS.has('scaffoldfiles'));
});

test('SHELL_TOOLS 与 NETWORK_AI_TOOLS 均非空并含规范名', () => {
  assert.ok(mod.SHELL_TOOLS.size > 0);
  assert.ok(mod.NETWORK_AI_TOOLS.size > 0);
  assert.ok(mod.SHELL_TOOLS.has('shellcommand'));
  assert.ok(mod.SHELL_TOOLS.has('bash'));
  assert.ok(mod.NETWORK_AI_TOOLS.has('websearch'));
  assert.ok(mod.NETWORK_AI_TOOLS.has('imagegenerate'));
});

test('三个工具集都是冻结的 Set 实例', () => {
  for (const s of [mod.FILE_TOOLS, mod.SHELL_TOOLS, mod.NETWORK_AI_TOOLS]) {
    assert.ok(s instanceof Set);
    assert.ok(Object.isFrozen(s));
  }
});

test('normalize 小写并剥除空格下划线短横', () => {
  assert.strictEqual(mod.normalize('Shell_Command'), 'shellcommand');
  assert.strictEqual(mod.normalize('Web Search'), 'websearch');
  assert.strictEqual(mod.normalize('FILE-Edit'), 'fileedit');
});

test('normalize 对 null/undefined 收敛为空串，对数字强转字符串', () => {
  assert.strictEqual(mod.normalize(null), '');
  assert.strictEqual(mod.normalize(undefined), '');
  assert.strictEqual(mod.normalize(123), '123');
});

test('classify 对三档代表工具（大小写不敏感）各返回对应 TIER 值', () => {
  assert.strictEqual(mod.classify('write'), mod.TIER.FILE);
  assert.strictEqual(mod.classify('MultiEdit'), mod.TIER.FILE);
  assert.strictEqual(mod.classify('ShellCommand'), mod.TIER.SHELL);
  assert.strictEqual(mod.classify('WebSearch'), mod.TIER.NETWORK_AI);
});

test('classify 归一化后再查表：web_search 与 "AGENT TOOL" 分别命中', () => {
  assert.strictEqual(mod.classify('web_search'), 'NETWORK_AI');
  assert.strictEqual(mod.classify('apply_patch'), 'FILE');
});

test('classify 对空串/纯空白/null/未知名一律返回 UNKNOWN 而非抛', () => {
  assert.strictEqual(mod.classify(''), 'UNKNOWN');
  assert.strictEqual(mod.classify('   '), 'UNKNOWN');
  assert.strictEqual(mod.classify(null), 'UNKNOWN');
  assert.strictEqual(mod.classify(undefined), 'UNKNOWN');
  assert.strictEqual(mod.classify('no_such_tool'), 'UNKNOWN');
  assert.strictEqual(mod.classify(123), 'UNKNOWN');
});

test('Read 不在 FILE 集（只读工具）：classify 判 UNKNOWN、effectiveTier 保守降 SHELL', () => {
  assert.strictEqual(mod.classify('Read'), 'UNKNOWN');
  assert.strictEqual(mod.effectiveTier('Read'), 'SHELL');
});

test('effectiveTier 只把 UNKNOWN 折叠为 SHELL，三档原样透传', () => {
  assert.strictEqual(mod.effectiveTier('some_unknown_tool'), 'SHELL');
  assert.strictEqual(mod.effectiveTier('edit'), 'FILE');
  assert.strictEqual(mod.effectiveTier('bash'), 'SHELL');
  assert.strictEqual(mod.effectiveTier('fetch'), 'NETWORK_AI');
});

test('effectiveTier 恒三档之一，任何输入都不跳出枚举（total 契约）', () => {
  const samples = ['', null, undefined, 0, {}, [], 'WebSearch', 'shell'];
  for (const s of samples) {
    assert.ok(['FILE', 'SHELL', 'NETWORK_AI'].includes(mod.effectiveTier(s)), `样本 ${String(s)} 越界`);
  }
});
