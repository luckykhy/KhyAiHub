'use strict';

// startupBeatsWiring.test — 启动板块接线的**回归锁**（[DESIGN-ARCH-115] §4.2）。
//
// 这些不是普通单测，是防止后来者把 D1 重新引入的闸。仓库已有先例：
// tests/cli/tui/updateWiring.test.js 也是用正则断言源码，而非运行时行为。
//
// 锁的三件事：
//   1. 完成信号不得再引用 banner 的 git 来源探测（D1 根因）；
//   2. 不得再出现「用 setTimeout 标记启动完成」（D3 空壳拍）；
//   3. 完成只能通过 startupBeats 的 done()/preload() 上报。
//
// 另含 BootScreen 门控取值的运行时断言（0 / legacy / off / 默认）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'cli',
  'tui',
  'ink-components',
  'App.js'
);

const src = fs.readFileSync(APP_JS, 'utf8');

test('D1 锁：启动完成信号不得引用 banner 的 git 来源探测', () => {
  // 旧实现：`}, [bannerUpdateLine]);` —— 把 banner 的 git 来源探测当「会话就绪」
  // 信号。于是启动时长 = 该探测耗时 + 1.5s + 0.4s，而那个探测与启动毫无关系。
  assert.equal(
    /\[bannerUpdateLine\]/.test(src),
    false,
    'App.js 又出现了以 bannerUpdateLine 为依赖的 effect —— 这是 D1 的根因，禁止恢复'
  );
});

test('D3 锁：不得用 setTimeout 标记启动完成（空壳拍）', () => {
  // 旧实现：`setTimeout(() => setBootComplete(true), 400)`，
  // 以及 `setTimeout(markSession, 1500)` —— 两步都是纯时长驱动，与真实工作无关。
  assert.equal(
    /setBootComplete\(true\)/.test(src),
    false,
    '不得再直接把 boot 标记为完成 —— 完成必须来自 startupBeats 的真实信号'
  );
  assert.equal(
    /setTimeout\(markSession/.test(src),
    false,
    '不得再出现时长驱动的 markSession'
  );
});

test('接线：完成信号统一走 startupBeats', () => {
  assert.ok(
    /require\('\.\.\/\.\.\/startupBeats'\)/.test(src),
    'App.js 必须 require startupBeats（启动板块单一真源）'
  );
  assert.ok(
    /beats\.preload\(\[/.test(src),
    'App.js 必须用 preload 标记 pre-mount 已完成的四拍（预热起点）'
  );
  assert.ok(/beats\.done\('render'\)/.test(src), '拍 3 render 必须由首帧 commit 上报');
  assert.ok(/beats\.done\('gateway'\)/.test(src), '拍 5 gateway 必须有真实完成信号');
  assert.ok(
    /beats\.fail\('gateway'/.test(src),
    '网关等不到确认必须走 fail()（可见降级），而不是 done()（伪装成功）'
  );
  assert.ok(/beats\.subscribe/.test(src), 'App 必须订阅节拍真源以驱动 _bootComplete');
});

test('接线：降级看门狗是唯一超时，且只用于降级', () => {
  // 允许 GATEWAY_DEGRADE_MS 这一个超时常量，但它的处理必须是 fail 而非 done。
  assert.ok(/GATEWAY_DEGRADE_MS/.test(src), '网关降级看门狗常量应存在');
  assert.equal(
    /GATEWAY_DEGRADE_MS\s*=\s*\d+/.test(src),
    true,
    'GATEWAY_DEGRADE_MS 应为一个具体毫秒数'
  );
});

test('接线：旧的 ad-hoc tracker 已被移除', () => {
  assert.equal(/_bootTracker/.test(src), false, '_bootTracker 应已移除');
  assert.equal(/createBootTracker/.test(src), false, 'createBootTracker 应已移除');
  assert.equal(/_bootGateRef/.test(src), false, '_bootGateRef 应已移除（原为「一 ref 两用」）');
});

// ── BootScreen 门控（运行时） ────────────────────────────────────────────

const { isBootScreenEnabled } = require('../../../src/cli/tui/ink-components/BootScreen');

test('BootScreen 门控：默认开', () => {
  assert.equal(isBootScreenEnabled({}), true);
  assert.equal(isBootScreenEnabled({ KHY_BOOT_SCREEN: '1' }), true);
});

test('BootScreen 门控：0 / legacy / off / no 全部关闭', () => {
  for (const v of ['0', 'legacy', 'off', 'no', 'false', ' LEGACY ', 'Off']) {
    assert.equal(isBootScreenEnabled({ KHY_BOOT_SCREEN: v }), false, `${v} 应关闭启动屏`);
  }
});

test('BootScreen：不再导出旧的 ad-hoc tracker API', () => {
  const mod = require('../../../src/cli/tui/ink-components/BootScreen');
  assert.equal(typeof mod.BootScreen, 'function');
  assert.equal(typeof mod.createBootTracker, 'undefined', 'createBootTracker 应已被 startupBeats 取代');
  assert.equal(typeof mod.STEPS, 'undefined', ' STEPS 常量应已被 startupBeats 的 BEATS 取代');
});

// ── 实时进度显示接线（「进度必须实时显示」）───────────────────────────────
//
// 守的缺陷（实测数据，Windows 真实 PTY）：
//   bin/khy.js 的 5 步引导行在 **0.37s** 就走完并 end() 了，而整个启动有 30s+。
//   剩下最长的两段 —— **ink 渲染引擎装载（11.5s）** 与 **App 首帧渲染（11s）** ——
//   全程零进度显示，然后启动屏一出场就已经是 4/6 = 67%，紧接着冻结 7s。
//   这两段都跑在 Ink 挂载**之前**，所以启动屏（依赖 ink）结构上不可能显示它们。
// 两个接线点因此是必须的：
//   (a) replSession 用 pre-Ink 渲染器（bootPhaseLine）盖住 ink 装载窗口；
//   (b) tui/app.js 在渲染整棵 App 树之前先落地一帧轻量启动屏。
// 谁把这两处删掉，「一开始就卡在 67%」就会立刻复现。

const REPL_SESSION_JS = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'replSession.js');
const TUI_APP_JS = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'app.js');
const KHY_BIN_JS = path.join(__dirname, '..', '..', '..', 'bin', 'khy.js');
const BOOT_PHASE_LINE_JS = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'cli',
  'bootPhaseLine.js'
);

test('接线(a)：replSession 必须用实时百分比行盖住 ink 装载窗口', () => {
  const s = fs.readFileSync(REPL_SESSION_JS, 'utf8');
  assert.ok(
    /bootPhaseLine'\)\.openBootWindow\(/.test(s),
    'replSession 必须经 bootPhaseLine.openBootWindow 开进度行（封装在叶子里，巨石不再长）'
  );
  assert.ok(/加载渲染引擎/.test(s), '必须有「加载渲染引擎」阶段 —— 那是整个启动最长的一段');
  assert.ok(
    /_bootWindow\.close\(\)/.test(s),
    '交棒前必须 close() —— bootPhaseLine 是瞬时行，Ink 接管终端前必须擦掉自己并还原 console'
  );
  // 百分比必须来自节拍真源，不得自造进度。这条契约现在住在 openBootWindow 里
  // （replSession 只是接线方），所以要连叶子一起验 —— 否则「谁把百分比源换成自造曲线」
  // 就没人拦了。
  const leaf = fs.readFileSync(BOOT_PHASE_LINE_JS, 'utf8');
  assert.ok(
    /progress\(\)\.percent/.test(leaf),
    'openBootWindow 必须消费节拍真源的实时百分比（progress().percent），不得自造进度'
  );
});

test('接线(b)：tui/app.js 必须在渲染 App 树之前先落地一帧轻量启动屏', () => {
  const s = fs.readFileSync(TUI_APP_JS, 'utf8');
  assert.ok(/ink-components\/BootScreen/.test(s), 'app.js 必须先渲染 BootScreen 预热帧');
  // 预热帧的 render 必须出现在整棵 App 树的 render **之前**。
  const bootIdx = s.indexOf('bootScreenMod.BootScreen');
  const appIdx = s.indexOf('render(React.createElement(App, { options })');
  assert.ok(bootIdx > 0 && appIdx > 0, '两处 render 都必须存在');
  assert.ok(
    bootIdx < appIdx,
    '轻量启动屏必须在 App 树之前渲染 —— 否则 App 首帧那 10s+ 仍是纯黑，启动屏照旧最后才出现'
  );
});

test('接线：bin/khy.js 的进度行包装器必须透传第 4 参（percentSource）', () => {
  // 历史上这里只接一个形参，把调用点的 (step, totalSteps) 静默吞掉，
  // 于是引导期永远只显示「已等待 Xs」、从不显示百分比。同一个坑不能再踩一次。
  const s = fs.readFileSync(KHY_BIN_JS, 'utf8');
  assert.ok(
    /_bootPhaseWrite = \(phaseText, step, totalSteps, percentSource\)/.test(s),
    '包装器必须声明第 4 个形参'
  );
  assert.ok(
    /_bootPhaseLine\.write\(phaseText, step, totalSteps, percentSource\)/.test(s),
    '包装器必须把第 4 参透传给 write()'
  );
});

test('接线(c)：env/auth/session 必须在真实工作点上报，不能只靠 App 首帧追认', () => {
  // 只靠 preload 追认的后果（实测）：ink 装载这段最长窗口里进度曲线贴着地板（8%），
  // 然后在 App 首帧跳到 67% —— 正是用户报的那个跳变。真实点上报后曲线才连续。
  const s = fs.readFileSync(KHY_BIN_JS, 'utf8');
  for (const id of ['env', 'auth', 'session']) {
    assert.ok(
      new RegExp(`_markBeat\\('${id}'\\)`).test(s),
      `bin/khy.js 必须在真实工作点上报 ${id} 拍`
    );
  }
  assert.ok(
    /require\('\.\.\/src\/cli\/startupBeats'\)\.beats/.test(s),
    '上报必须走 startupBeats 的模块级单例（启动板块单一真源）'
  );
});

test('接线(c)：workspace 拍必须在信任闸门之后上报', () => {
  const s = fs.readFileSync(REPL_SESSION_JS, 'utf8');
  assert.ok(/beats\.done\('workspace'\)/.test(s), 'workspace 拍必须在 replSession 上报');
  const trustIdx = s.indexOf('ensureWorkspaceTrust');
  const markIdx = s.indexOf("beats.done('workspace')");
  assert.ok(trustIdx > 0 && markIdx > trustIdx, 'workspace 上报必须晚于信任闸门（那才是这一拍的真实工作）');
});
