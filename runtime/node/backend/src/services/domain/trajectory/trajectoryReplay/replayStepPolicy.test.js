'use strict';

/**
 * replayStepPolicy.test.js — 钉死回放步策略纯叶子契约：步进超时的 opts/env 优先级、
 * SHELL 预批准白名单合并顺序、execApproval 模式匹配语义（精确或通配才命中，前缀不算）、
 * EXEC_APPROVED 不可伪造符号盖戳、控制应答器的非交互 allow。
 *
 * 实测更正：matchCommandPattern('npm test','npm') === false —— 「命令以模式开头」并不会命中，
 * 必须精确相等或带 * 通配；本文件按真实语义钉死。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const mod = require('./replayStepPolicy');
const { EXEC_APPROVED, matchCommandPattern } = require('../../../execApproval');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

test('导出恰为 6 个符号且默认步进超时为 120000 毫秒', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'DEFAULT_STEP_TIMEOUT_MS',
    '_approveParams',
    '_replayControlResponder',
    '_shellAllowList',
    '_shellPreApproved',
    '_stepTimeoutMs',
  ]);
  assert.strictEqual(mod.DEFAULT_STEP_TIMEOUT_MS, 120000);
});

test('_stepTimeoutMs 无 opts 无 env 时回退默认 120000', () => {
  withEnv('KHY_REPLAY_STEP_TIMEOUT_MS', undefined, () => {
    assert.strictEqual(mod._stepTimeoutMs(), mod.DEFAULT_STEP_TIMEOUT_MS);
    assert.strictEqual(mod._stepTimeoutMs({}), 120000);
    assert.strictEqual(mod._stepTimeoutMs(undefined), 120000);
  });
});

test('_stepTimeoutMs opts.activityTimeoutMs 仅接受正有限数，0/负数/NaN 被忽略', () => {
  assert.strictEqual(mod._stepTimeoutMs({ activityTimeoutMs: 5000 }), 5000);
  assert.strictEqual(mod._stepTimeoutMs({ activityTimeoutMs: 0 }), 120000);
  assert.strictEqual(mod._stepTimeoutMs({ activityTimeoutMs: -5 }), 120000);
  assert.strictEqual(mod._stepTimeoutMs({ activityTimeoutMs: NaN }), 120000);
});

test('_stepTimeoutMs env 覆盖生效且 opts 优先于 env，垃圾 env 回退默认', () => {
  withEnv('KHY_REPLAY_STEP_TIMEOUT_MS', '7000', () => {
    assert.strictEqual(mod._stepTimeoutMs({}), 7000);
    assert.strictEqual(mod._stepTimeoutMs({ activityTimeoutMs: 9000 }), 9000);
  });
  withEnv('KHY_REPLAY_STEP_TIMEOUT_MS', 'abc', () => {
    assert.strictEqual(mod._stepTimeoutMs({}), 120000);
  });
});

test('_shellAllowList 无 opts 无 env 返回空数组（反空转基线）', () => {
  withEnv('KHY_REPLAY_SHELL_ALLOW', undefined, () => {
    assert.deepStrictEqual(mod._shellAllowList({}), []);
    assert.deepStrictEqual(mod._shellAllowList(), []);
  });
});

test('_shellAllowList env 按换行与逗号切分去空白', () => {
  withEnv('KHY_REPLAY_SHELL_ALLOW', 'npm test, echo hi\ngit status', () => {
    assert.deepStrictEqual(mod._shellAllowList({}), ['npm test', 'echo hi', 'git status']);
  });
});

test('_shellAllowList 合并顺序为 opts 在前 env 在后', () => {
  withEnv('KHY_REPLAY_SHELL_ALLOW', 'npm test, echo hi', () => {
    assert.deepStrictEqual(mod._shellAllowList({ preApprovedShell: ['ls'] }), ['ls', 'npm test', 'echo hi']);
  });
});

test('_shellPreApproved 空白名单或缺 step/缺 command 时一律 false', () => {
  assert.strictEqual(mod._shellPreApproved({ params: { command: 'npm test' } }, []), false);
  assert.strictEqual(mod._shellPreApproved(null, ['npm*']), false);
  assert.strictEqual(mod._shellPreApproved({ params: {} }, ['npm*']), false);
  assert.strictEqual(mod._shellPreApproved({}, ['npm*']), false);
});

test('_shellPreApproved 精确模式命中，裸前缀不命中，星号通配命中（execApproval 真实语义）', () => {
  assert.strictEqual(matchCommandPattern('npm test', 'npm test'), true);
  assert.strictEqual(matchCommandPattern('npm test', 'npm'), false);
  assert.strictEqual(matchCommandPattern('npm test', 'npm*'), true);
  assert.strictEqual(mod._shellPreApproved({ params: { command: 'npm test' } }, ['npm test']), true);
  assert.strictEqual(mod._shellPreApproved({ params: { command: 'npm test' } }, ['npm']), false);
  assert.strictEqual(mod._shellPreApproved({ params: { command: 'npm test' } }, ['npm*']), true);
});

test('_approveParams 返回带 EXEC_APPROVED 符号的克隆且不改动原对象', () => {
  const src = { command: 'ls' };
  const out = mod._approveParams(src);
  assert.strictEqual(out.command, 'ls');
  assert.strictEqual(out[EXEC_APPROVED], true);
  assert.notStrictEqual(out, src);
  assert.strictEqual(src[EXEC_APPROVED], undefined);
});

test('_approveParams 对 null/非对象入参收敛为空壳对象但仍盖符号（回放永不漏批）', () => {
  for (const v of [null, undefined, 'str', 42]) {
    const out = mod._approveParams(v);
    assert.deepStrictEqual(Object.keys(out), []);
    assert.strictEqual(out[EXEC_APPROVED], true, `入参 ${String(v)} 应仍带批准符号`);
  }
});

test('_replayControlResponder 返回异步应答器，产出 allow 与默认 L2 词 YES', async () => {
  let responder;
  withEnv('KHY_REPLAY_L2_CONFIRM', undefined, () => {
    responder = mod._replayControlResponder();
  });
  assert.strictEqual(typeof responder, 'function');
  const r = await responder();
  assert.deepStrictEqual(r, { behavior: 'allow', typed: 'YES' });
});

test('_replayControlResponder 的 L2 确认词在构造时读 env 且允许覆盖', async () => {
  let responder;
  withEnv('KHY_REPLAY_L2_CONFIRM', 'CONFIRM-REPLAY', () => {
    responder = mod._replayControlResponder();
  });
  const r = await responder();
  assert.strictEqual(r.typed, 'CONFIRM-REPLAY');
  assert.strictEqual(r.behavior, 'allow');
});
