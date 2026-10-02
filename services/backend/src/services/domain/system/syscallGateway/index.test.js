'use strict';

/**
 * index.test.js — 系统调用审批网关门面契约（单一裁决权威、进程内内存态）。
 *
 * fail 方向：**fail-closed 是铁律**——网关自身异常判 DENY；旁路注入一次即熔断并拒绝；
 * 熔断优先于一切（跳闸后连 L0 只读也拒）。仅涉及 env 的用例保存/恢复精确键：
 * KHY_SYSCALL_GATEWAY / KHY_GATEWAY_BREAKER_SMART。所有交互器为注入假对象，无真实 IO；
 * makeControlPrompter 用例使用只读意图（L0，_wantsWorkspace=false）以避免真实工作区采集。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gw = require('./index');

const CWD = 'D:/proj';

function freshSessionPrefix() {
  // 每支用例用独立 sessionId 并在结尾清理，避免跨用例内存态串扰。
}

test('门面导出齐备且常量非空', () => {
  assert.ok(typeof gw.evaluate === 'function');
  assert.ok(Object.values(gw.DECISIONS).length > 0);
  assert.deepStrictEqual(gw.LEVELS, { L0: 'L0', L1: 'L1', L2: 'L2' });
  assert.strictEqual(gw.DEFAULT_L2_CONFIRM, 'YES');
  assert.strictEqual(typeof gw.isExemptible, 'function');
  assert.strictEqual(gw.isExemptible('L2'), false);
});

test('isEnabled 默认开、=off 关', () => {
  const saved = process.env.KHY_SYSCALL_GATEWAY;
  try {
    delete process.env.KHY_SYSCALL_GATEWAY;
    assert.strictEqual(gw.isEnabled(), true);
    process.env.KHY_SYSCALL_GATEWAY = 'off';
    assert.strictEqual(gw.isEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.KHY_SYSCALL_GATEWAY;
    else process.env.KHY_SYSCALL_GATEWAY = saved;
  }
  freshSessionPrefix();
});

test('evaluate L0 只读自动放行', async () => {
  const r = await gw.evaluate({ sessionId: 'ix-read', tool: 'Read', params: { file_path: 'src/a.js' }, cwd: CWD });
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.decision, gw.DECISIONS.AUTO_ALLOW);
  assert.strictEqual(r.level, 'L0');
  gw.resetSession('ix-read');
});

test('evaluate L2 删除无交互器 → 拒绝且不熔断（环境性拒绝），附指引', async () => {
  const r = await gw.evaluate({ sessionId: 'ix-rm', tool: 'Bash', params: { command: 'rm -rf x' }, cwd: CWD });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.level, 'L2');
  assert.strictEqual(r.tripped, false, '环境性拒绝不得跳闸');
  assert.ok(r.reasons.some((s) => s.includes('合规途径')));
  gw.resetSession('ix-rm');
});

test('evaluate 旁路注入键 → 熔断并拒绝', async () => {
  const r = await gw.evaluate({ sessionId: 'ix-bp', tool: 'Bash', params: { command: 'ls', force: true }, cwd: CWD });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.tripped, true);
  assert.ok(r.reasons.some((s) => s.includes('旁路注入')));
  gw.resetSession('ix-bp');
});

test('熔断优先于一切：跳闸后连 L0 只读也拒', async () => {
  await gw.evaluate({ sessionId: 'ix-prio', tool: 'Bash', params: { command: 'ls', force: true }, cwd: CWD });
  const r = await gw.evaluate({ sessionId: 'ix-prio', tool: 'Read', params: { file_path: 'src/a.js' }, cwd: CWD });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.tripped, true);
  gw.resetSession('ix-prio');
});

test('evaluate L2 键入正确确认串 → 放行', async () => {
  const r = await gw.evaluate(
    { sessionId: 'ix-yes', tool: 'Bash', params: { command: 'rm -rf x' }, cwd: CWD },
    { prompter: { confirmL2: async () => 'YES' } }
  );
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.decision, gw.DECISIONS.USER_ALLOW);
  gw.resetSession('ix-yes');
});

test('真·硬闯计数：L2 确认串不匹配累计 3 次跳闸', async () => {
  const prompter = { confirmL2: async () => 'nope' };
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push((await gw.evaluate({ sessionId: 'ix-mm', tool: 'Bash', params: { command: 'rm x' }, cwd: CWD }, { prompter })).tripped);
  }
  assert.deepStrictEqual(out, [false, false, true]);
  gw.resetSession('ix-mm');
});

test('智能熔断门控开：环境性拒绝 3 次不跳闸；门控关则跳闸', async () => {
  const saved = process.env.KHY_GATEWAY_BREAKER_SMART;
  try {
    delete process.env.KHY_GATEWAY_BREAKER_SMART;
    let tripped = false;
    for (let i = 0; i < 3; i++) {
      tripped = (await gw.evaluate({ sessionId: 'ix-env', tool: 'Bash', params: { command: 'rm x' }, cwd: CWD })).tripped;
    }
    assert.strictEqual(tripped, false, '环境性拒绝默认不计数');
    gw.resetSession('ix-env');

    process.env.KHY_GATEWAY_BREAKER_SMART = 'off';
    let trippedOff = false;
    for (let i = 0; i < 3; i++) {
      trippedOff = (await gw.evaluate({ sessionId: 'ix-env2', tool: 'Bash', params: { command: 'rm x' }, cwd: CWD })).tripped;
    }
    assert.strictEqual(trippedOff, true, '门控关回退逐次计数');
    gw.resetSession('ix-env2');
  } finally {
    if (saved === undefined) delete process.env.KHY_GATEWAY_BREAKER_SMART;
    else process.env.KHY_GATEWAY_BREAKER_SMART = saved;
  }
});

test('evaluate autoApproveL1 放行黄灯写入', async () => {
  const r = await gw.evaluate(
    { sessionId: 'ix-auto', tool: 'Write', params: { file_path: 'src/a.js' }, cwd: CWD },
    { autoApproveL1: true }
  );
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.level, 'L1');
  gw.resetSession('ix-auto');
});

test('submitManifest 接纳 L1 拒收 L2 并反映在 inspect', () => {
  const n = gw.submitManifest('ix-man', [{ action: 'write', scope: 'project' }, { action: 'delete', scope: 'system' }]);
  assert.strictEqual(n, 1);
  const snap = gw.inspect('ix-man');
  assert.strictEqual(snap.manifest.length, 1);
  gw.resetSession('ix-man');
});

test('跳闸清场：注入 killer 杀掉登记在册子进程', async () => {
  const killed = [];
  const opts = { breakerOpts: { killer: (pid) => killed.push(pid) } };
  gw.registerChild('ix-kill', 42, opts);
  gw.registerChild('ix-kill', 43, opts);
  gw.unregisterChild('ix-kill', 42);
  const r = await gw.evaluate({ sessionId: 'ix-kill', tool: 'Bash', params: { command: 'ls', force: true }, cwd: CWD }, opts);
  assert.strictEqual(r.tripped, true);
  assert.deepStrictEqual(killed, [43]);
  gw.resetSession('ix-kill');
});

test('resetSession 幂等、inspect 缺失会话返回 null', () => {
  assert.strictEqual(gw.inspect('ix-none'), null);
  gw.resetSession('ix-none');
  assert.strictEqual(gw.inspect('ix-none'), null);
});

test('resetAllSessions 返回清除数且绝不抛', () => {
  gw.evaluate({ sessionId: 'ix-all', tool: 'Read', params: { file_path: 'a.js' }, cwd: CWD });
  const n = gw.resetAllSessions();
  assert.strictEqual(typeof n, 'number');
  assert.ok(n >= 0);
});

test('evaluate 空 call 不抛、fail-closed 拒绝', async () => {
  const r = await gw.evaluate();
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.decision, gw.DECISIONS.DENY);
  assert.strictEqual(r.level, 'L2');
  gw.resetAllSessions();
});

test('makeControlPrompter 非函数入参返回 null', () => {
  assert.strictEqual(gw.makeControlPrompter(null), null);
  assert.strictEqual(gw.makeControlPrompter('x'), null);
});

test('makeControlPrompter askL1 映射各宿主应答', async () => {
  const intent = { tool: 'Read', action: 'read', scope: 'project', resource: '', raw: {} };
  const mk = (resp) => gw.makeControlPrompter(async () => resp);
  assert.strictEqual(await mk(true).askL1(intent), 'once');
  assert.strictEqual(await mk('always').askL1(intent), 'session');
  assert.strictEqual(await mk(false).askL1(intent), 'deny');
  assert.strictEqual(await mk({ behavior: 'allow' }).askL1(intent), 'once');
  assert.strictEqual(await mk({ response: { behavior: 'allow-always' } }).askL1(intent), 'session');
  assert.strictEqual(await mk({ scope: 'session' }).askL1(intent), 'session');
  assert.strictEqual(await mk(null).askL1(intent), 'deny');
});

test('makeControlPrompter confirmL2 解析 typed/session 与异常应答', async () => {
  const intent = { tool: 'Read', action: 'read', scope: 'project', resource: '', raw: {} };
  const mk = (resp) => gw.makeControlPrompter(async () => resp);
  assert.deepStrictEqual(await mk({ typed: 'YES' }).confirmL2(intent), { typed: 'YES', session: false });
  assert.deepStrictEqual(await mk({ response: { behavior: 'allow-always', typed: 'YES' } }).confirmL2(intent), { typed: 'YES', session: true });
  assert.deepStrictEqual(await mk(true).confirmL2(intent), { typed: '', session: false });
  assert.strictEqual(await mk(undefined).askL1(intent), 'deny');

  const thrower = gw.makeControlPrompter(async () => { throw new Error('net'); });
  assert.strictEqual(await thrower.askL1(intent), 'deny');
});
