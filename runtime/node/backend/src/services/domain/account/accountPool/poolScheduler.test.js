'use strict';

// Co-located contract tests for poolScheduler.js (timer/DB GC leaf).
// Everything is MEASURED (probe .khyos/tmp/probeSched.js). The module is a dependency-injection
// factory: `getDb` is faked here, so no real database, home directory, or filesystem is ever
// touched — there is no disk seam to redirect for this unit.

const test = require('node:test');
const assert = require('node:assert/strict');

const createScheduler = require('./poolScheduler');

const HB = 60000;
const GC = 60000;

// Fake sequelize-ish recorder: every query call is logged, SELECT gets the scripted result.
function mkDb(selectResult, opts = {}) {
  const calls = [];
  const db = {
    query: async (sql, o) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), o, optionsMissing: o === undefined });
      if (/^SELECT/.test(sql)) {
        if (opts.throwSelect) throw new Error('boom-select');
        return selectResult;
      }
      if (opts.throwUpdate) throw new Error('boom-update');
      return [[], 'ok'];
    },
  };
  return { calls, db };
}

const oneLease = [[{ request_id: 'req-1', account_id: 'acc-1' }]];

test('工厂在构造时解构 deps：缺省或 null 入参立即抛 TypeError', () => {
  assert.throws(() => createScheduler(), TypeError);
  assert.throws(() => createScheduler(null), TypeError);
  const s = createScheduler({ getDb: () => null, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
  assert.deepEqual(Object.keys(s), ['startGC', 'runGC', 'stopGC']);
  for (const key of ['startGC', 'runGC', 'stopGC']) assert.equal(typeof s[key], 'function');
  assert.equal(Object.getPrototypeOf(s), Object.prototype);
});

test('runGC 在无库时直接返回 undefined，一条 SQL 都不发', async () => {
  for (const falsy of [null, undefined, 0, '', false]) {
    const f = mkDb(oneLease);
    const s = createScheduler({ getDb: () => falsy, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
    assert.equal(await s.runGC(), undefined);
    assert.deepEqual(f.calls, []);
  }
});

test('KNOWN-DEFECT: getDb 自身抛错或缺失会让 runGC reject，而同函数里的 SQL 异常被静默吞掉', async () => {
  const throwing = createScheduler({ getDb: () => { throw new Error('getDb boom'); }, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
  await assert.rejects(() => throwing.runGC(), /getDb boom/);
  const missing = createScheduler({ HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
  await assert.rejects(() => missing.runGC(), TypeError); // "getDb is not a function" is outside the try

  // Inside the try, every failure mode is swallowed and runGC resolves.
  const sel = createScheduler({ getDb: () => mkDb(null, { throwSelect: true }).db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
  assert.equal(await sel.runGC(), undefined);
  const upd = mkDb([[]], { throwUpdate: true });
  const updSched = createScheduler({ getDb: () => upd.db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
  assert.equal(await updSched.runGC(), undefined);
  assert.equal(upd.calls.length, 2, 'the throwing UPDATE was attempted');
});

test('心跳超时换算为分钟：向下取整且夹到最小 1，负数同样落到 1', async () => {
  const matrix = [
    [0, '-1 minutes'], [1, '-1 minutes'], [59999, '-1 minutes'], [60000, '-1 minutes'],
    [61000, '-1 minutes'], [90000, '-1 minutes'], [120000, '-2 minutes'], [129999, '-2 minutes'],
    [150000, '-2 minutes'], [-1000, '-1 minutes'], ['120000', '-2 minutes'], ['-1', '-1 minutes'],
    // Values that *coerce* to 0 land on the clamp, unlike the NaN family below.
    [null, '-1 minutes'], [-Infinity, '-1 minutes'], [[0], '-1 minutes'], [true, '-1 minutes'],
  ];
  for (const [hb, expected] of matrix) {
    const f = mkDb([[]]);
    const s = createScheduler({ getDb: () => f.db, HEARTBEAT_TIMEOUT_MS: hb, GC_INTERVAL_MS: GC });
    await s.runGC();
    assert.deepEqual(f.calls[0].o, { replacements: { heartbeatClause: expected } }, `HEARTBEAT_TIMEOUT_MS=${String(hb)}`);
  }
});

test('KNOWN-DEFECT: 非数值心跳超时不做校验，向 SQL 替换值注入 "-NaN/-Infinity minutes"', async () => {
  for (const [hb, expected] of [[NaN, '-NaN minutes'], [Infinity, '-Infinity minutes'], [undefined, '-NaN minutes'], [{}, '-NaN minutes'], ['-', '-NaN minutes'], [() => 1, '-NaN minutes']]) {
    const f = mkDb([[]]);
    const s = createScheduler({ getDb: () => f.db, HEARTBEAT_TIMEOUT_MS: hb, GC_INTERVAL_MS: GC });
    await s.runGC();
    assert.equal(f.calls[0].o.replacements.heartbeatClause, expected, `HEARTBEAT_TIMEOUT_MS=${String(hb)}`);
  }
});

test('GC 只跑两条基础 SQL：SELECT 带 replacements，冷却恢复 UPDATE 不带选项对象', async () => {
  const f = mkDb([[]]);
  const s = createScheduler({ getDb: () => f.db, HEARTBEAT_TIMEOUT_MS: 120000, GC_INTERVAL_MS: GC });
  await s.runGC();
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].sql, /^SELECT request_id, account_id FROM account_leases/);
  assert.match(f.calls[0].sql, /status = 'active'/);
  assert.match(f.calls[0].sql, /lease_until < datetime\('now'\)/);
  assert.match(f.calls[0].sql, /last_heartbeat < datetime\('now', :heartbeatClause\)/);
  assert.match(f.calls[1].sql, /^UPDATE account_pool SET status = 'available', cooldown_until = NULL/);
  assert.match(f.calls[1].sql, /cooldown_until <= datetime\('now'\)$/);
  assert.equal(f.calls[1].o, undefined, 'the cooldown UPDATE is issued without an options object');
});

test('每条过期租约按序追加两条 UPDATE，分别绑定 account_id 与 request_id', async () => {
  const f = mkDb([[{ request_id: 'rq', account_id: 'ac' }]]);
  const s = createScheduler({ getDb: () => f.db, HEARTBEAT_TIMEOUT_MS: 120000, GC_INTERVAL_MS: GC });
  await s.runGC();
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[2].o, { replacements: { id: 'ac' } });
  assert.match(f.calls[2].sql, /leased_by = NULL, lease_until = NULL/);
  assert.match(f.calls[2].sql, /WHERE id = :id$/);
  assert.deepEqual(f.calls[3].o, { replacements: { requestId: 'rq' } });
  assert.match(f.calls[3].sql, /^UPDATE account_leases SET status = 'expired'/);
  assert.match(f.calls[3].sql, /WHERE request_id = :requestId$/);

  const many = mkDb([[{ request_id: 'r1', account_id: 'a1' }, { request_id: 'r2', account_id: 'a2' }]]);
  await createScheduler({ getDb: () => many.db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC }).runGC();
  assert.equal(many.calls.length, 6);
  assert.deepEqual(many.calls.map((c) => c.sql.split(' ')[0]), ['SELECT', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE', 'UPDATE']);
  assert.deepEqual([many.calls[2].o, many.calls[4].o], [{ replacements: { id: 'a1' } }, { replacements: { id: 'a2' } }]);
});

test('KNOWN-DEFECT: SELECT 结果只取第一元素且无类型守卫，字符串结果被按字符当租约迭代', async () => {
  // Non-iterable results make `const [expired] = ...` throw; the swallow hides it entirely.
  for (const bad of [null, undefined, 42, {}, true]) {
    const f = mkDb(bad);
    await createScheduler({ getDb: () => f.db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC }).runGC();
    assert.equal(f.calls.length, 1, `${String(bad)} aborts GC after the SELECT only`);
  }
  // Result wrapper [] yields expired === undefined -> the `|| []` guard rescues it.
  const emptyWrap = mkDb([]);
  await createScheduler({ getDb: () => emptyWrap.db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC }).runGC();
  assert.equal(emptyWrap.calls.length, 2);
  assert.equal(emptyWrap.calls[0].o.replacements.heartbeatClause, '-1 minutes');

  // A string result is "iterable": only char 0 is taken, then iterated char-wise, and the
  // lease fields come out undefined while the keys stay present on the replacements object.
  const str = mkDb('abc');
  await createScheduler({ getDb: () => str.db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC }).runGC();
  assert.equal(str.calls.length, 4);
  assert.equal('id' in str.calls[2].o.replacements, true);
  assert.equal(str.calls[2].o.replacements.id, undefined);
  assert.equal('requestId' in str.calls[3].o.replacements, true);
  assert.equal(str.calls[3].o.replacements.requestId, undefined);

  // Only the first row-set is consumed; a second result set is silently ignored.
  const two = mkDb([[{ request_id: 'r1', account_id: 'a1' }], 'ignored']);
  await createScheduler({ getDb: () => two.db, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC }).runGC();
  assert.equal(two.calls.length, 4);
});

test('startGC 装一个 unref 的定时器，重复 start 先清旧的；stopGC 幂等', () => {
  const orig = { si: global.setInterval, ci: global.clearInterval };
  const created = [];
  const cleared = [];
  global.setInterval = (cb, ms, ...rest) => {
    const t = orig.si(cb, ms, ...rest);
    created.push({ t, ms, cb });
    return t;
  };
  global.clearInterval = (t) => {
    if (created.some((c) => c.t === t)) cleared.push(t);
    return orig.ci(t);
  };
  try {
    const s = createScheduler({ getDb: () => null, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: 900000 });
    s.startGC();
    assert.equal(created.length, 1);
    assert.equal(created[0].ms, 900000, 'GC_INTERVAL_MS is passed through verbatim');
    assert.equal(created[0].t.hasRef(), false, 'the timer must be unref-ed so it never holds the loop');
    s.startGC();
    assert.equal(created.length, 2);
    assert.equal(cleared.length, 1, 'the previous timer was cleared instead of stacked');
    assert.notEqual(created[0].t, created[1].t);
    s.stopGC();
    assert.equal(cleared.length, 2);
    s.stopGC();
    assert.equal(cleared.length, 2, 'stopGC on an already-stopped scheduler is a no-op');

    // GC_INTERVAL_MS is not validated at all — junk reaches setInterval unchanged.
    for (const junk of [-50, 0, undefined, NaN]) {
      const junkSched = createScheduler({ getDb: () => null, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: junk });
      assert.doesNotThrow(() => junkSched.startGC());
      assert.equal(created[created.length - 1].ms, junk);
      junkSched.stopGC();
    }
  } finally {
    global.setInterval = orig.si;
    global.clearInterval = orig.ci;
    for (const c of created) { try { orig.ci(c.t); } catch { /* already cleared */ } }
  }
  assert.equal(cleared.length, created.length, 'no timer is leaked by the test itself');
});

test('定时器回调吞掉 runGC 的 rejection 且不返回任何值', () => {
  const orig = { si: global.setInterval, ci: global.clearInterval };
  const created = [];
  global.setInterval = (cb, ms, ...rest) => {
    const t = orig.si(cb, ms, ...rest);
    created.push({ t, cb });
    return t;
  };
  global.clearInterval = (t) => orig.ci(t);
  try {
    const ok = createScheduler({ getDb: () => null, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: 900000 });
    ok.startGC();
    assert.equal(created[created.length - 1].cb(), undefined);
    ok.stopGC();

    // Same callback with a getDb that rejects: nothing escapes, nothing is returned.
    const bad = createScheduler({ getDb: () => { throw new Error('timer-db'); }, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: 900000 });
    bad.startGC();
    assert.doesNotThrow(() => created[created.length - 1].cb());
    bad.stopGC();
  } finally {
    global.setInterval = orig.si;
    global.clearInterval = orig.ci;
    for (const c of created) { try { orig.ci(c.t); } catch { /* ignore */ } }
  }
});

test('两个 scheduler 实例互不干扰：私有计时器状态不共享', () => {
  const orig = { si: global.setInterval, ci: global.clearInterval };
  const created = [];
  global.setInterval = (cb, ms, ...rest) => {
    const t = orig.si(cb, ms, ...rest);
    created.push(t);
    return t;
  };
  global.clearInterval = (t) => orig.ci(t);
  try {
    const a = createScheduler({ getDb: () => null, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: 900000 });
    const b = createScheduler({ getDb: () => null, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: 900000 });
    a.startGC();
    b.stopGC(); // b never started: must not tear down a's timer
    assert.equal(created.length, 1);
    assert.equal(created[0].hasRef(), false);
    a.stopGC();
    assert.notEqual(a, b);
  } finally {
    global.setInterval = orig.si;
    global.clearInterval = orig.ci;
    for (const t of created) { try { orig.ci(t); } catch { /* ignore */ } }
  }
});

test('runGC 每次都重新调用 getDb（库被换掉后立刻生效）', async () => {
  const first = mkDb([[]]);
  const second = mkDb([[{ request_id: 'x', account_id: 'y' }]]);
  let current = first.db;
  const s = createScheduler({ getDb: () => current, HEARTBEAT_TIMEOUT_MS: HB, GC_INTERVAL_MS: GC });
  await s.runGC();
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 0);
  current = second.db;
  await s.runGC();
  assert.equal(second.calls.length, 4);
  assert.equal(first.calls.length, 2, 'the old handle is not queried again');
});
