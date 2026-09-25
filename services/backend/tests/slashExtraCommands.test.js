'use strict';

/**
 * slashExtraCommands 纯叶子单测(node:test)。
 *   node --test services/backend/tests/slashExtraCommands.test.js
 *
 * 证:10 条 extras 内容/顺序锁定、mergeExtraCommands 幂等去重(既有优先)、不 mutate 入参、
 * 冻结不可变。这是经典 REPL 与 TUI 菜单的共同真源,任何漂移都在此显形。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SLASH_EXTRA_COMMANDS, mergeExtraCommands } = require('../src/cli/slashExtraCommands');

test('SLASH_EXTRA_COMMANDS: 锁定 10 条,cmd 顺序与历史一致', () => {
  const cmds = SLASH_EXTRA_COMMANDS.map((e) => e.cmd);
  assert.deepEqual(cmds, [
    '/study', '/role', '/mind', '/intent', '/new', '/reset',
    '/folded', '/trace', '/pool', '/push',
  ]);
});

// BUG-127/129: '/hud' '/think' '/optimize' were advertised here with no executor behind
// them — handlers/{hud,think,optimize}.js exist in no ref, and the REPL's picker branches
// (replSession.js:6437/6469) therefore always print 「操作失败: Cannot find module」.
// Thinking effort is genuinely reachable as /effort, which lives in commandRegistry, so
// withdrawing these three costs no capability. Menu entries must be runnable.
test('SLASH_EXTRA_COMMANDS: 无执行器的命令不得露出(BUG-127 /hud, BUG-129 /think /optimize)', () => {
  const cmds = SLASH_EXTRA_COMMANDS.map((e) => e.cmd);
  for (const phantom of ['/hud', '/think', '/optimize']) {
    assert.ok(!cmds.includes(phantom), `${phantom} 不该再被菜单露出`);
  }
});

test('SLASH_EXTRA_COMMANDS: 每条有 cmd/label/desc,/mind 带 flag', () => {
  for (const e of SLASH_EXTRA_COMMANDS) {
    assert.ok(e.cmd && e.cmd.startsWith('/'), `${e.cmd} 应以 / 开头`);
    assert.equal(typeof e.label, 'string');
    assert.equal(typeof e.desc, 'string');
    assert.ok(e.label.length > 0 && e.desc.length > 0);
  }
  const mind = SLASH_EXTRA_COMMANDS.find((e) => e.cmd === '/mind');
  assert.equal(mind.flag, 'mind');
});

// BUG-128: '/trace' was advertised as a debug toggle with 「on|off|status」, but the real
// command (handlers/trace.js) only takes show|list|verify and plays back session
// trajectories. A menu row is a promise about the command's argument contract.
test('SLASH_EXTRA_COMMANDS: /trace 菜单文案须兑现真实参数(BUG-128)', () => {
  const trace = SLASH_EXTRA_COMMANDS.find((e) => e.cmd === '/trace');
  assert.ok(!/on\|off\|status/.test(trace.desc), `/trace desc 仍承诺不存在的开关: ${trace.desc}`);
  assert.ok(trace.desc.includes('轨迹回放'), `应说明这是轨迹回放: ${trace.desc}`);
  assert.ok(trace.desc.includes('verify'), `应列出真实子命令 show|list|verify: ${trace.desc}`);
});

test('mergeExtraCommands: 空 base → 全 10 条按序追加', () => {
  const merged = mergeExtraCommands([]);
  assert.equal(merged.length, 10);
  assert.equal(merged[0].cmd, '/study');
  assert.equal(merged[9].cmd, '/push');
});

test('mergeExtraCommands: 既有优先,同名 cmd 不重复(用 base 的对象)', () => {
  const base = [{ cmd: '/pool', label: 'BASE-POOL', desc: 'base wins' }];
  const merged = mergeExtraCommands(base);
  const pools = merged.filter((c) => c.cmd === '/pool');
  assert.equal(pools.length, 1);
  assert.equal(pools[0].label, 'BASE-POOL'); // base 优先,extras 的 /pool 被跳过
  assert.equal(merged.length, 1 + 9);         // 10 extras 里 /pool 被跳过 → +9
});

test('mergeExtraCommands: 不 mutate 入参', () => {
  const base = [{ cmd: '/x' }];
  const snapshot = base.slice();
  const merged = mergeExtraCommands(base);
  assert.deepEqual(base, snapshot);   // 入参未变
  assert.notEqual(merged, base);      // 返回新数组
  assert.equal(base.length, 1);
});

test('mergeExtraCommands: 幂等——对已含 extras 的列表再合并不增不减', () => {
  const once = mergeExtraCommands([]);
  const twice = mergeExtraCommands(once);
  assert.deepEqual(twice.map((c) => c.cmd), once.map((c) => c.cmd));
});

test('mergeExtraCommands: 非数组入参按空处理(绝不抛)', () => {
  assert.equal(mergeExtraCommands(null).length, 10);
  assert.equal(mergeExtraCommands(undefined).length, 10);
  assert.equal(mergeExtraCommands('nope').length, 10);
});

test('SLASH_EXTRA_COMMANDS: 冻结不可变', () => {
  assert.ok(Object.isFrozen(SLASH_EXTRA_COMMANDS));
  assert.ok(Object.isFrozen(SLASH_EXTRA_COMMANDS[0]));
});
