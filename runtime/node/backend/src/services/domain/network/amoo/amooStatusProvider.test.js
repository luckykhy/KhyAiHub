'use strict';

/**
 * amooStatusProvider.test.js — co-located suite for the Amoo status provider.
 *
 * IO: none against a real device. The runner and the liveness probe are injected
 * fakes, the clock is injected, and every adb/HTTP path that the real stack would
 * take is replaced by a promise the test controls. No phone, no adb.exe, no
 * bridge socket.
 *
 * What is pinned here is the caching discipline the live measurements forced:
 *   - single flight: two concurrent refreshes must not become two collectStatus
 *     runs (each one is real adb.exe processes),
 *   - TTL counts from COMPLETION, so an 8s slow sample cannot make the poll loop
 *     queue forever,
 *   - an outer deadline abandons the wait but cannot kill the adb child, so the
 *     late result must be discarded by sequence number instead of overwriting a
 *     newer snapshot,
 *   - a failed collectStatus keeps the last good snapshot and marks it stale
 *     instead of throwing or blanking the panel,
 *   - busy (dispatch running) swaps the screen-reading snapshot for a heartbeat
 *     probe, because uiautomator dump is a device-level contended resource,
 *   - http_401 heals the 6-hour token cache instead of lying "bridge offline".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AmooStatusProvider, withDeadline } = require('./amooStatusProvider');

const SERIAL = '192.168.2.46:33743';

function happyStatus(overrides = {}) {
  return {
    ok: true,
    adb: { resolved: true, source: 'env', path: 'C:/fake/adb.exe', message: '' },
    device: { connected: true, serial: SERIAL, detail: '设备在线', reason: null },
    forwards: { ok: true, ports: ['tcp:8896', 'tcp:8898'], detail: 'forward list' },
    bridge: {
      online: true,
      latencyMs: 21,
      detail: '桥服务在线',
      port: 8896,
      transport: 'forward',
      baseUrl: 'http://127.0.0.1:8896',
      token: '5500…8d30',
      tokenDetail: '已从设备读取',
      tools: 22,
      mode: 'lite',
    },
    screen: { nodes: 18, chatChars: 0, chatLines: 0, inputChars: 0, sendVisible: false },
    uiAutomation: { bridgeUiTools: false, screenReadPath: 'PC 侧 adb shell uiautomator dump' },
    summary: '',
    ...overrides,
  };
}

function brokenStatus() {
  return happyStatus({
    ok: false,
    device: { connected: false, serial: SERIAL, detail: 'offline', reason: 'device_unreachable' },
    forwards: { ok: false, ports: [], detail: '设备未连接，未建立 forward' },
    bridge: {
      online: false,
      latencyMs: 0,
      detail: 'bridge_unreachable',
      port: 8896,
      transport: 'forward',
      token: null,
      tokenDetail: '不可用：读取超时',
      tools: null,
      mode: null,
    },
    screen: null,
  });
}

/** 可控时钟 + 可计数 runner。 */
function harness(opts = {}) {
  const state = { clock: 0, calls: 0, heals: 0, listeners: 0 };
  const now = () => state.clock;
  const runner = {
    config: { bridge: { port: 8896, transport: 'forward', baseUrl: 'http://127.0.0.1:8896' } },
    collectStatus: async () => {
      state.calls += 1;
      if (opts.fail) {
        throw new Error(opts.fail);
      }
      return opts.status || happyStatus();
    },
    client: {
      invalidateToken: () => {
        state.heals += 1;
      },
    },
  };
  const provider = new AmooStatusProvider({
    runner,
    ttlMs: opts.ttlMs,
    deadlineMs: opts.deadlineMs,
    now,
    ...(opts.liveness ? { liveness: opts.liveness } : {}),
  });
  return { provider, state, runner };
}

function model_row(model, key) {
  return model.rows.find((r) => r.key === key);
}

// ── 基本语义 ───────────────────────────────────────────────────────────────

test('构造后是 idle，一次 IO 都没有', () => {
  const { provider, state } = harness();
  const snap = provider.getSnapshot();
  assert.equal(snap.state, 'idle');
  assert.equal(snap.model.tone, 'idle');
  assert.equal(snap.model.headline, '尚未读取手机状态');
  assert.equal(snap.lastError, null);
  assert.equal(snap.stale, false);
  assert.equal(state.calls, 0);
  assert.deepEqual(provider.stats(), {
    fetches: 0,
    cacheHits: 0,
    timeouts: 0,
    tokenHeals: 0,
    lastMs: 0,
    lastAt: 0,
  });
});

test('第一次 refresh 落定成 ready 并通知订阅者', async () => {
  const { provider, state } = harness();
  const seen = [];
  const off = provider.onChange((snap) => seen.push(snap.state));
  await provider.refresh();
  const snap = provider.getSnapshot();
  assert.equal(snap.state, 'ready');
  assert.equal(snap.model.headline, '协作链正常');
  assert.equal(state.calls, 1);
  assert.equal(provider.stats().fetches, 1);
  assert.ok(provider.stats().lastMs >= 0);
  assert.deepEqual(seen, ['ready']);
  off();
  await provider.refresh({ force: true });
  assert.equal(seen.length, 1, '退订后不再收到通知');
});

test('TTL 内重复 refresh 是缓存命中，不打设备', async () => {
  const { provider, state } = harness({ ttlMs: 5000 });
  await provider.refresh();
  state.clock += 4999;
  await provider.refresh();
  assert.equal(state.calls, 1);
  assert.equal(provider.stats().cacheHits, 1);
  state.clock += 2;
  await provider.refresh();
  assert.equal(state.calls, 2);
});

test('force 无视 TTL', async () => {
  const { provider, state } = harness({ ttlMs: 60000 });
  await provider.refresh();
  await provider.refresh({ force: true });
  assert.equal(state.calls, 2);
});

test('invalidate 让下一次 refresh 无视 TTL', async () => {
  const { provider, state } = harness({ ttlMs: 60000 });
  await provider.refresh();
  provider.invalidate();
  await provider.refresh();
  assert.equal(state.calls, 2);
});

test('TTL 从完成时刻起算：8 秒的慢样本不会让轮询永久排队', async () => {
  // 这是实测逼出来的规则：collectStatus 最坏约 28s。若 TTL 从发起时刻起算，
  // 一个慢样本会让「下一次该刷了」永远落在飞行中，面板几小时不更新。
  const state = { clock: 0, calls: 0 };
  let release;
  const runner = {
    collectStatus: () =>
      new Promise((resolve) => {
        release = () => {
          state.clock += 8000; // 采集本身耗时 8s
          resolve(happyStatus());
        };
      }),
  };
  const provider = new AmooStatusProvider({ runner, ttlMs: 5000, now: () => state.clock });
  const pending = provider.refresh();
  release();
  await pending;
  assert.equal(provider.stats().fetches, 1);
  // 完成后 100ms 内再刷：必须是缓存命中
  state.clock += 100;
  await provider.refresh();
  assert.equal(provider.stats().fetches, 1);
  assert.equal(provider.stats().cacheHits, 1);
  // 越过 TTL 才真的再打一次
  state.clock += 6000;
  await provider.refresh();
  assert.equal(provider.stats().fetches, 2);
});

test('并发 refresh 单飞：两次调用只跑一次 collectStatus', async () => {
  const state = { clock: 0, calls: 0 };
  const runner = {
    collectStatus: async () => {
      state.calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return happyStatus();
    },
  };
  const provider = new AmooStatusProvider({ runner, ttlMs: 1000, now: () => state.clock });
  const [a, b] = await Promise.all([provider.refresh(), provider.refresh()]);
  assert.equal(state.calls, 1);
  assert.equal(a, b, '第二个调用方复用同一个 in-flight promise');
  assert.equal(provider.stats().cacheHits, 1);
});

// ── 失败语义 ───────────────────────────────────────────────────────────────

test('collectStatus 抛错时保留上一份好快照并标陈旧，不抛不清空', async () => {
  const state = { clock: 0, calls: 0, heals: 0 };
  let broken = false;
  const runner = {
    collectStatus: async () => {
      state.calls += 1;
      if (broken) {
        throw new Error('adb devices timed out');
      }
      return happyStatus();
    },
    client: { invalidateToken: () => {} },
  };
  const provider = new AmooStatusProvider({ runner, ttlMs: 1000, now: () => state.clock });
  await provider.refresh();
  assert.equal(provider.getSnapshot().model.headline, '协作链正常');
  broken = true;
  state.clock += 2000;
  const snap = await provider.refresh();
  assert.equal(provider.getSnapshot().state, 'ready', '有旧快照就不是 error');
  assert.equal(provider.getSnapshot().stale, true);
  assert.equal(provider.getSnapshot().lastError, 'adb devices timed out');
  // 旧数据照画，只是降级
  assert.equal(provider.getSnapshot().model.headline, '协作链正常');
  assert.equal(snap.status.device.connected, true);
});

test('首次就失败时给 error 与 idle 行模型', async () => {
  const { provider } = harness({ fail: 'adb unresolved' });
  await provider.refresh();
  const snap = provider.getSnapshot();
  assert.equal(snap.state, 'error');
  assert.equal(snap.lastError, 'adb unresolved');
  assert.equal(snap.model.tone, 'idle');
  assert.equal(snap.model.headline, '尚未读取手机状态');
  assert.equal(snap.status, null);
});

test('collectStatus 同步抛错也不炸出 provider', async () => {
  const runner = {
    collectStatus: () => {
      throw new Error('sync boom');
    },
  };
  const provider = new AmooStatusProvider({ runner, ttlMs: 100 });
  const snap = await provider.refresh();
  assert.equal(provider.getSnapshot().state, 'error');
  assert.equal(provider.getSnapshot().lastError, 'sync boom');
  // refresh 的返回值就是内部快照：失败时它是「空快照 + error」，不是 null、也不是抛
  assert.equal(snap.state, 'error');
  assert.equal(snap.status, null);
});

test('没有 runner 时不打设备，只报 no_status_source', async () => {
  const provider = new AmooStatusProvider({ ttlMs: 100 });
  await provider.refresh();
  assert.equal(provider.getSnapshot().state, 'error');
  assert.equal(provider.getSnapshot().lastError, 'no_status_source');
});

// ── deadline 与序号判废 ────────────────────────────────────────────────────

test('outer deadline 放弃等待；晚到的结果被序号判废', async () => {
  const state = { clock: 0 };
  let releaseLate;
  let call = 0;
  const runner = {
    collectStatus: () => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => {
          releaseLate = resolve; // 永不及时resolve的那个
        });
      }
      return Promise.resolve(happyStatus());
    },
  };
  const provider = new AmooStatusProvider({ runner, ttlMs: 1000, deadlineMs: 20, now: () => state.clock });
  await provider.refresh();
  assert.equal(provider.stats().timeouts, 1);
  assert.equal(provider.getSnapshot().state, 'error');
  assert.equal(provider.getSnapshot().lastError, 'status_deadline');

  await provider.refresh({ force: true });
  assert.equal(provider.getSnapshot().state, 'ready');
  assert.equal(provider.getSnapshot().model.headline, '协作链正常');

  // 被 deadline 放弃的那次现在才回来（deadline 杀不掉已 spawn 的 adb）：
  // 它必须被丢弃，不能覆盖更新的快照。
  releaseLate(brokenStatus());
  await new Promise((r) => setTimeout(r, 30));
  const snap = provider.getSnapshot();
  assert.equal(snap.state, 'ready');
  assert.equal(snap.model.headline, '协作链正常');
  assert.equal(model_row(snap.model, 'device').value, SERIAL);
});

test('withDeadline：值、拒绝、超时三种出口', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 50), 7);
  const rejected = await withDeadline(Promise.reject(new Error('nope')), 50);
  assert.equal(rejected.__error.message, 'nope');
  const timedOut = await withDeadline(new Promise(() => {}), 10);
  assert.equal(timedOut.__deadline, true);
  // 非 promise 入参也不能炸
  assert.equal(await withDeadline(5, 10), 5);
});

// ── 忙位互斥 ───────────────────────────────────────────────────────────────

function heartbeatLiveness(overrides = {}) {
  const state = { probes: 0 };
  return {
    state,
    liveness: {
      probe: async () => {
        state.probes += 1;
        return {
          ok: true,
          channel: 'adb-shell',
          httpPortBound: true,
          status: { running: true, pid: 1234, http_port: 8896, mode: 'lite', tools: 22 },
          ...overrides,
        };
      },
    },
  };
}

test('忙位期间只读心跳，不跑 collectStatus（dump 是设备级争用资源）', async () => {
  const liveness = heartbeatLiveness();
  const { provider, state } = harness({ ttlMs: 1000, liveness: liveness.liveness });
  await provider.refresh();
  assert.equal(state.calls, 1);
  assert.equal(model_row(provider.getSnapshot().model, 'screen').value, '18 节点');

  provider.setBusy(true);
  await provider.refresh({ force: true });
  const snap = provider.getSnapshot();
  // 一次 collectStatus 都没多跑
  assert.equal(state.calls, 1);
  assert.equal(liveness.state.probes, 1);
  assert.equal(snap.degraded, true);
  assert.equal(snap.busy, true);
  // 心跳快照只画测到的东西
  assert.equal(model_row(snap.model, 'bridge').value, '心跳正常');
  assert.equal(model_row(snap.model, 'bridge').tone, 'warn');
  assert.equal(model_row(snap.model, 'tools').value, '22 个（lite）');
  assert.equal(model_row(snap.model, 'device').value, '—');
  assert.equal(model_row(snap.model, 'screen').value, '读不到');
  assert.equal(snap.model.tone, 'busy');
  assert.equal(snap.model.headline, '正在向 Amoo 下发任务…');
  assert.ok(snap.model.notes.some((n) => n.includes('只保留桥心跳')));
});

test('心跳探活失败时如实报桥不在线', async () => {
  const liveness = heartbeatLiveness({ ok: false, httpPortBound: false, error: 'probe_failed', status: null });
  const { provider } = harness({ ttlMs: 1000, liveness: liveness.liveness });
  provider.setBusy(true);
  await provider.refresh();
  const snap = provider.getSnapshot();
  assert.equal(model_row(snap.model, 'bridge').value, '不在线');
  assert.match(model_row(snap.model, 'bridge').hint, /心跳探活失败/);
});

test('忙位且没有心跳源时什么都不测，旧快照原样留下', async () => {
  const { provider, state } = harness({ ttlMs: 1000 });
  await provider.refresh();
  assert.equal(state.calls, 1);
  provider.setBusy(true);
  state.clock += 100000; // 早过期了
  const snap = await provider.refresh({ force: true });
  assert.equal(state.calls, 1, '没有 liveness 就一次都不测');
  assert.equal(snap.status.device.connected, true);
  assert.equal(provider.getSnapshot().busy, true);
  assert.equal(provider.getSnapshot().stale, true);
});

test('忙位撤掉后作废 TTL，下一次 refresh 补全量快照', async () => {
  const liveness = heartbeatLiveness();
  const { provider, state } = harness({ ttlMs: 100000, liveness: liveness.liveness });
  await provider.refresh();
  provider.setBusy(true);
  await provider.refresh({ force: true });
  assert.equal(model_row(provider.getSnapshot().model, 'screen').value, '读不到');
  provider.setBusy(false);
  await provider.refresh();
  assert.equal(state.calls, 2);
  assert.equal(model_row(provider.getSnapshot().model, 'screen').value, '18 节点');
  assert.equal(provider.getSnapshot().degraded, false);
});

// ── 令牌自愈 ───────────────────────────────────────────────────────────────

test('http_401 触发令牌失效化（6 小时缓存否则会误报数小时）', async () => {
  const { provider, state } = harness({
    ttlMs: 100,
    status: happyStatus({
      ok: false,
      bridge: {
        online: false,
        latencyMs: 0,
        detail: 'http_401',
        port: 8896,
        transport: 'forward',
        token: null,
        tokenDetail: '不可用：读取超时',
        tools: null,
        mode: null,
      },
    }),
  });
  await provider.refresh();
  assert.equal(state.heals, 1);
  assert.equal(provider.stats().tokenHeals, 1);
});

test('非 401 的桥不在线不动令牌', async () => {
  const { provider, state } = harness({ ttlMs: 100, status: brokenStatus() });
  await provider.refresh();
  assert.equal(state.heals, 0);
  assert.equal(provider.stats().tokenHeals, 0);
});

// ── 实时进度记录（零 IO） ──────────────────────────────────────────────────

test('noteStep / notePoll / noteDispatchResult 只改模型，一次 IO 都不发', async () => {
  const { provider, state } = harness({ ttlMs: 100000 });
  await provider.refresh();
  assert.equal(state.calls, 1);

  const seen = [];
  provider.onChange((snap) => seen.push(snap.model.dispatch && snap.model.dispatch.rows[0].value));

  provider.noteStep({ id: 'ensure-device', ok: true, detail: '设备在线' });
  provider.noteStep({ id: 'fill-text', ok: false, detail: '剪贴板写入失败：http_401' });
  provider.notePoll({ round: 3, maxRounds: 40, waitedMs: 9000, chatChars: 12 });
  let snap = provider.getSnapshot();
  assert.equal(state.calls, 1, '进度记录不准碰设备');
  assert.equal(snap.busy, false, '忙位由 setBusy 说了算，noteStep 不擅自置位');
  assert.equal(snap.model.dispatch.rows[0].value, '2 步');
  assert.match(snap.model.dispatch.rows[0].hint, /fill-text（失败）/);
  assert.equal(snap.model.dispatch.rows[1].value, '第 3/40 轮');
  assert.equal(snap.model.progress.steps.length, 2);
  assert.equal(seen.length, 3);

  provider.noteDispatchResult({
    ok: true,
    code: 'ok',
    message: '已收到 Amoo 答复。',
    reply: { text: '好的', truncated: false, originalChars: 2 },
    poll: { rounds: 5, waitedMs: 21000, stopReason: 'reply_stable_text_stable' },
    steps: [{ id: 'poll-reply', ok: true, detail: '轮次 5' }],
  });
  snap = provider.getSnapshot();
  assert.equal(snap.model.progress, null, '结果到来时清掉实时进度');
  assert.equal(snap.model.dispatch.headline, '已收到 Amoo 答复。');
  assert.equal(snap.model.dispatch.rows[0].value, '已收到答复');
  assert.equal(state.calls, 1);
});

test('垃圾进度入参被忽略，不抛', async () => {
  const { provider } = harness();
  provider.noteStep(null);
  provider.noteStep('x');
  provider.notePoll(42);
  provider.noteDispatchResult([]);
  const snap = provider.getSnapshot();
  assert.equal(snap.model.dispatch, null);
  assert.equal(snap.model.tone, 'idle');
});

test('坏订阅者不弄坏供数器', async () => {
  const { provider } = harness();
  provider.onChange(() => {
    throw new Error('bad listener');
  });
  await provider.refresh();
  assert.equal(provider.getSnapshot().state, 'ready');
  // 退订函数对非函数入参也安全
  assert.equal(typeof provider.onChange(null), 'function');
});

test('getSnapshot 在陈旧翻转时同步补徽章', async () => {
  const state = { clock: 0 };
  const runner = { collectStatus: async () => happyStatus() };
  const provider = new AmooStatusProvider({ runner, ttlMs: 1000, now: () => state.clock });
  await provider.refresh();
  assert.equal(provider.getSnapshot().model.badges.length, 0);
  state.clock += 12000;
  const snap = provider.getSnapshot();
  assert.equal(snap.stale, true);
  const badge = snap.model.badges.find((b) => b.key === 'stale');
  assert.ok(badge, '不等到下一次轮询就该打上陈旧徽章');
  assert.equal(badge.text, '数据停更 12s');
});
