'use strict';

// startupBeats.test — 启动节拍契约（[DESIGN-ARCH-115] §4）。
// 纯叶子：零 IO，故测试只断言状态机行为。
//
// 覆盖：初始态 / 状态迁移 / 单调推进 / 未知 id fail-soft / preload 预热起点 /
// 订阅通知 / 就绪判据（含「非 critical 失败 = 降级就绪」）/ 阻断性失败 / 进度概览。
//
// 末尾两条是**设计锁**，不是普通单测：
//   - 「不提供定时标记完成的 API」锁死 D1 的根因（禁止用超时伪装完成）；
//   - 「就绪判定不读任何外部信号」锁死 §4.2 规则 2。

const test = require('node:test');
const assert = require('node:assert');

const {
  BEATS,
  STATUS,
  createBeatTracker,
  isTerminal,
} = require('../../src/cli/startupBeats');

const ids = () => BEATS.map((b) => b.id);

test('BEATS: 六拍顺序与 critical 归属', () => {
  assert.deepEqual(ids(), ['env', 'auth', 'render', 'workspace', 'gateway', 'session']);
  const critical = BEATS.filter((b) => b.critical).map((b) => b.id);
  assert.deepEqual(critical, ['env', 'auth', 'render']);
});

test('初始态：全部 pending，未就绪', () => {
  const t = createBeatTracker();
  assert.equal(t.beats.length, 6);
  t.beats.forEach((b) => assert.equal(b.status, STATUS.PENDING));
  assert.equal(t.isReady(), false);
  // elapsedMs 读的是**真实时钟**（now() - startedAt），所以绝不能断言它恰为 0 ——
  // 构造 tracker 到取值之间只要跨过 1ms 边界就会得到 1，实测约 25% 概率翻红。
  // 这里只锁「进度账本本身」：0/6 完成、未就绪；elapsedMs 单独断言为非负。
  const p = t.progress();
  assert.equal(p.done, 0);
  assert.equal(p.total, 6);
  assert.equal(p.ready, false);
  assert.ok(p.elapsedMs >= 0, 'elapsedMs 应为非负数');
});

test('状态迁移：pending → active → done', () => {
  const t = createBeatTracker();
  assert.equal(t.start('render'), true);
  assert.equal(t.get('render').status, STATUS.ACTIVE);
  assert.equal(t.done('render'), true);
  assert.equal(t.get('render').status, STATUS.DONE);
});

test('单调推进：终态不可回退，重复上报静默忽略（§4.2 规则 4）', () => {
  const t = createBeatTracker();
  t.done('env');
  assert.equal(t.start('env'), false, 'done 后不能再回到 active');
  assert.equal(t.done('env'), false, '重复 done 应被忽略');
  assert.equal(t.fail('env'), false, 'done 后不能再 fail');
  assert.equal(t.get('env').status, STATUS.DONE);

  t.fail('auth', 'boom');
  assert.equal(t.done('auth'), false, 'failed 后不能再 done');
  assert.equal(t.get('auth').status, STATUS.FAILED);
});

test('未知 id / 非法输入：fail-soft，绝不抛（纯叶子纪律）', () => {
  const t = createBeatTracker();
  assert.equal(t.done('nope'), false);
  assert.equal(t.start(undefined), false);
  assert.equal(t.fail(null), false);
  assert.equal(t.get('nope'), null);
  assert.equal(t.preload('not-an-array'), 0);
  assert.doesNotThrow(() => t.subscribe(null));
});

test('preload：预热起点让已完成的拍首帧即 ✓', () => {
  const t = createBeatTracker();
  // Ink 挂载前 env/auth/workspace/session 已做完（replSession pre-mount）
  const n = t.preload(['env', 'auth', 'workspace', 'session']);
  assert.equal(n, 4);
  assert.equal(t.get('env').status, STATUS.DONE);
  assert.equal(t.progress().done, 4);
  // 剩下的两拍仍待推进 → 尚未就绪
  assert.equal(t.isReady(), false);
});

test('preload 幂等：已终态的拍不重复计数', () => {
  const t = createBeatTracker();
  t.done('env');
  assert.equal(t.preload(['env']), 0);
  assert.equal(t.preload(['env', 'auth']), 1);
});

test('订阅：变更时收到通知，退订后不再收到', () => {
  const t = createBeatTracker();
  let hits = 0;
  const off = t.subscribe(() => {
    hits += 1;
  });
  t.done('env');
  t.done('auth');
  assert.equal(hits, 2);
  off();
  t.done('render');
  assert.equal(hits, 2, '退订后不应再收到通知');
});

test('订阅者抛异常不影响其它订阅者（启动绝不能被拖垮）', () => {
  const t = createBeatTracker();
  let reached = false;
  t.subscribe(() => {
    throw new Error('bad subscriber');
  });
  t.subscribe(() => {
    reached = true;
  });
  assert.doesNotThrow(() => t.done('env'));
  assert.equal(reached, true);
});

test('就绪判据：全部终态且无 critical 失败', () => {
  const t = createBeatTracker();
  ids().forEach((id) => t.done(id));
  assert.equal(t.isReady(), true);
  assert.equal(t.progress().ready, true);
  assert.equal(t.blockingFailure(), null);
});

test('降级就绪：非 critical 拍失败不阻断，计入 degraded（§6）', () => {
  const t = createBeatTracker();
  t.done('env');
  t.done('auth');
  t.done('render');
  t.done('workspace');
  t.fail('gateway', '网关不可达');
  t.done('session');
  assert.equal(t.isReady(), true, '非 critical 失败应降级就绪，而不是卡住');
  assert.equal(t.blockingFailure(), null);
  const deg = t.degraded();
  assert.equal(deg.length, 1);
  assert.equal(deg[0].id, 'gateway');
  assert.equal(deg[0].note, '网关不可达');
});

test('阻断：critical 拍失败时 isReady 恒 false', () => {
  const t = createBeatTracker();
  // 注意顺序语义：失败发生在「该拍推进时」，不是拍完成后追溯改判。
  // 单调推进规则（done 不可回退为 failed）会拒绝后者 —— 这是刻意的，见下一条测试。
  t.fail('auth', '未登录');
  ids().filter((id) => id !== 'auth').forEach((id) => t.done(id));
  assert.equal(t.isReady(), false, 'critical 拍失败后其余拍全绿也不算就绪');
  const blocking = t.blockingFailure();
  assert.ok(blocking);
  assert.equal(blocking.id, 'auth');
  assert.equal(blocking.note, '未登录');
  assert.equal(t.degraded().length, 0, 'critical 失败属阻断，不计入降级项');
});

test('单调性后果：已完成的拍不可追溯改判为 failed', () => {
  const t = createBeatTracker();
  t.done('auth');
  assert.equal(t.fail('auth', '事后发现未登录'), false);
  assert.equal(t.get('auth').status, STATUS.DONE);
  // 这条是刻意的：启动期的失败判定必须发生在「该拍推进时」，
  // 不允许事后把已完成的工作追认为失败 —— 否则状态可回退，界面会闪。
});

test('reset：回到初始态', () => {
  const t = createBeatTracker();
  ids().forEach((id) => t.done(id));
  t.reset();
  t.beats.forEach((b) => assert.equal(b.status, STATUS.PENDING));
  assert.equal(t.isReady(), false);
});

test('isTerminal 辅助：只有 done/failed 是终态', () => {
  assert.equal(isTerminal(STATUS.DONE), true);
  assert.equal(isTerminal(STATUS.FAILED), true);
  assert.equal(isTerminal(STATUS.ACTIVE), false);
  assert.equal(isTerminal(STATUS.PENDING), false);
});

// ── 实时百分比（显示层口径）─────────────────────────────────────────────
//
// 守的缺陷：`done/total` 的阶梯百分比在启动上完全失真 —— 实测（Windows 真实 PTY）
// env/auth/workspace/session 四拍在 **0.4s** 内全部做完，而 render（ink 装载 +
// App 首帧）要 **20s+**。于是进度条一出场就是 4/6 = 67% 并冻住 ——
// 用户报的正是「启动页一开始就卡在 67%」。本组锁住「实时曲线」的四条性质。

test('实时百分比：起步有斜坡，不从 0 瞬跳到已完成拍的下界', () => {
  let t = 0;
  const tr = createBeatTracker({ now: () => t });
  // 真实场景：四拍在 0.4s 内做完。此刻若直接显示 4/6 = 67%，就是用户报的那个缺陷。
  tr.preload(['env', 'auth', 'workspace', 'session']);
  assert.equal(tr.progress().percent, 0, '同一时刻不得直接显示 4/6 = 67%');
  t = 1000;
  const p1 = tr.progress().percent;
  assert.ok(p1 > 0 && p1 < (4 / 6) * 100, `起步斜坡应落在 0 ~ 66.7 之间，实测 ${p1}`);
  t = 3000;
  const p2 = tr.progress().percent;
  assert.ok(p2 > p1, '时间流逝必须单调上升');
});

test('实时百分比：未推进的拍绝不被越过（永不虚报）', () => {
  let t = 0;
  const tr = createBeatTracker({ now: () => t });
  tr.done('env');
  for (const ms of [0, 500, 2000, 10000, 60000]) {
    t = ms;
    const p = tr.progress().percent;
    // 只完成了 1 拍 → 显示值必须严格低于第 2 拍的下界（2/6 = 33.33）。
    assert.ok(p < (2 / 6) * 100, `t=${ms} 时 ${p}% 越过了下一拍的下界`);
  }
});

test('实时百分比：降级（非 critical 失败）也算推进 —— 否则网关降级时永远到不了 100%', () => {
  let t = 0;
  const tr = createBeatTracker({ now: () => t });
  ['env', 'auth', 'render', 'workspace', 'session'].forEach((id) => tr.done(id));
  tr.fail('gateway', '网关未就绪，已降级启动');
  t = 1000;
  assert.equal(tr.progress().percent, 100, '六拍全部进入终态 → 恰为 100');
  assert.equal(tr.isReady(), true);
});

test('实时百分比：critical 失败是阻断，进度不得谎报接近完成', () => {
  let t = 0;
  const tr = createBeatTracker({ now: () => t });
  tr.fail('auth', '未登录');
  ['env', 'render', 'workspace', 'gateway', 'session'].forEach((id) => tr.done(id));
  t = 60000;
  assert.ok(tr.progress().percent < 100, '阻断态绝不能显示 100%');
  assert.equal(tr.isReady(), false);
  assert.ok(tr.blockingFailure());
});

test('实时百分比：喂入真实时间线时单调不回退', () => {
  let t = 0;
  const tr = createBeatTracker({ now: () => t });
  const steps = [
    [100, () => tr.done('env')],
    [120, () => tr.done('auth')],
    [130, () => tr.done('workspace')],
    [140, () => tr.done('session')],
    [8000, () => tr.done('render')],
    [9500, () => tr.fail('gateway', '降级')],
  ];
  let i = 0;
  let prev = -1;
  for (t = 0; t <= 12000; t += 250) {
    while (i < steps.length && t >= steps[i][0]) {
      steps[i][1]();
      i += 1;
    }
    const p = tr.progress().percent;
    assert.ok(p >= prev - 1e-9, `t=${t} 出现回退：${prev} → ${p}`);
    prev = p;
  }
  assert.equal(prev, 100, '全部终态后必须恰好落在 100');
});

test('设计锁：progress() 是纯读 —— 同一时刻重复取值必须完全一致', () => {
  // 平滑曲线**不得**靠模块内的累积状态实现（那样两个渲染器会各自漂移、
  // 同一个时刻在引导行和启动屏上显示不同的数）。它必须是 (状态, 时钟) 的纯函数。
  let t = 0;
  const tr = createBeatTracker({ now: () => t });
  tr.done('env');
  t = 1234;
  assert.deepEqual(tr.progress(), tr.progress(), 'progress() 不得有隐藏状态');
});

// ── 设计锁 ──────────────────────────────────────────────────────────────
test('设计锁：不提供任何「定时标记完成」的 API（锁死 D1 根因）', () => {
  const t = createBeatTracker();
  // D1 的根因是「用超时判定完成」。若有人加回 doneAfter / markDoneAfter /
  // completeAfter 这类方法，启动时长又会变成一个可漂移的魔法数，
  // 而不是由真实工作决定。此断言就是那道闸。
  for (const forbidden of ['doneAfter', 'markDoneAfter', 'completeAfter', 'finishAfter', 'timeout']) {
    assert.equal(typeof t[forbidden], 'undefined', `禁止的定时完成 API 出现了：${forbidden}`);
  }
});

test('设计锁：就绪判定只依赖本模块状态，不读外部信号（§4.2 规则 2）', () => {
  // 历史实现把 banner 的 git 来源探测当「会话就绪」信号 —— 于是启动时长
  // 被一个无关功能决定。锁法：构造两个 tracker，喂入完全相同的完成序列，
  // 其中「外部世界」不同（这里用不同的注入时钟模拟），就绪时刻必须一致。
  const a = createBeatTracker({ now: () => 0 });
  const b = createBeatTracker({ now: () => 999999 });
  ids().forEach((id) => {
    a.done(id);
    b.done(id);
  });
  assert.equal(a.isReady(), b.isReady(), '就绪判定不得受时钟影响');
  assert.equal(a.blockingFailure(), b.blockingFailure());
});
