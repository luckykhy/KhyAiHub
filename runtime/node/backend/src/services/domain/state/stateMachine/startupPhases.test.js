'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// createFsm consults flagRegistry KHY_FSM_ENABLED (default-on). Pin the enabled
// branch deterministically for the whole file by removing any override, restoring after.
const _savedFlag = process.env.KHY_FSM_ENABLED;
delete process.env.KHY_FSM_ENABLED;
after(() => {
  if (_savedFlag === undefined) {
    delete process.env.KHY_FSM_ENABLED;
  } else {
    process.env.KHY_FSM_ENABLED = _savedFlag;
  }
});

const {
  STARTUP_PHASES,
  STARTUP_EVENTS,
  STARTUP_TRANSITIONS,
  createStartupFsm,
} = require('./startupPhases');

test('STARTUP_PHASES 冻结且键值对应规范阶段名', () => {
  assert.ok(Object.isFrozen(STARTUP_PHASES));
  assert.strictEqual(STARTUP_PHASES.PARSE_ARGS, 'parse_args');
  assert.strictEqual(STARTUP_PHASES.SHUTDOWN, 'shutdown');
});

test('STARTUP_EVENTS 冻结且含 advance/shutdown', () => {
  assert.ok(Object.isFrozen(STARTUP_EVENTS));
  assert.strictEqual(STARTUP_EVENTS.ADVANCE, 'advance');
  assert.strictEqual(STARTUP_EVENTS.SHUTDOWN, 'shutdown');
});

test('转换表：parse_args 各事件落到对应后继', () => {
  assert.strictEqual(STARTUP_TRANSITIONS['parse_args']['advance'], 'env_check');
  assert.strictEqual(STARTUP_TRANSITIONS['parse_args']['skip_to_running'], 'running');
  assert.strictEqual(STARTUP_TRANSITIONS['parse_args']['shutdown'], 'shutdown');
});

test('转换表：shutdown 为终态、无任何出边', () => {
  assert.strictEqual(STARTUP_TRANSITIONS['shutdown'], undefined);
  assert.strictEqual('shutdown' in STARTUP_TRANSITIONS, false);
});

test('转换表：env_check 无 skip_to_modules（该跳跃只在 parse_args 定义）', () => {
  assert.strictEqual(STARTUP_TRANSITIONS['env_check']['skip_to_modules'], undefined);
  assert.strictEqual(STARTUP_TRANSITIONS['env_check']['advance'], 'modules_load');
});

test('工厂：默认名 startupPhases 且初始态 parse_args', () => {
  const fsm = createStartupFsm();
  assert.strictEqual(fsm.name, 'startupPhases');
  assert.strictEqual(fsm.getState(), 'parse_args');
});

test('工厂：opts.name 覆盖机器名', () => {
  assert.strictEqual(createStartupFsm({ name: 'zz' }).name, 'zz');
});

test('fire advance 沿线性阶段推进并返回转移记录', () => {
  const fsm = createStartupFsm();
  const r = fsm.fire('advance');
  assert.deepEqual(r, { ok: true, from: 'parse_args', to: 'env_check', event: 'advance' });
  assert.strictEqual(fsm.getState(), 'env_check');
});

test('fire 未知事件不抛：保态、返回 ok:false', () => {
  const fsm = createStartupFsm();
  const r = fsm.fire('bogus');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.to, 'parse_args');
  assert.strictEqual(fsm.getState(), 'parse_args');
});

test('线性推进 5 步到 running，running 上 advance 非法、shutdown 合法', () => {
  const fsm = createStartupFsm();
  const steps = [];
  for (let i = 0; i < 5; i++) {
    steps.push(fsm.fire('advance').to);
  }
  assert.deepEqual(steps, ['env_check', 'modules_load', 'service_discover', 'repl_init', 'running']);
  assert.strictEqual(fsm.fire('advance').ok, false);
  assert.strictEqual(fsm.fire('shutdown').to, 'shutdown');
  assert.strictEqual(fsm.getState(), 'shutdown');
});

test('skip_to_running 一步跳到 running', () => {
  const fsm = createStartupFsm();
  assert.strictEqual(fsm.fire('skip_to_running').to, 'running');
});

test('history 记录每次 fire 且 toJSON 暴露四字段', () => {
  const fsm = createStartupFsm();
  fsm.fire('advance');
  assert.strictEqual(fsm.getHistory().length, 1);
  assert.deepEqual(Object.keys(fsm.toJSON()), ['name', 'state', 'since', 'history']);
});
