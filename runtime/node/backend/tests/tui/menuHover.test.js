'use strict';

/**
 * menuHover + clickTolerance — 鼠标层两条修正的回归守卫（2026-10-10）。
 *
 * 用户原话：「鼠标悬停，和点击对照不清晰，左键单击无法准确选择」。
 *
 * 实测定性（`.khyos/tmp` 探针 + 修正后的 VT 模型，见 feedback 目录）：
 *   · 点击的坐标映射本身是**准的**（`liveFrameTop` 的 offset 与 ink 实际画出的
 *     行一致，逐行对照过）；此前的「点不中」观感来自另两件事：
 *     ① 默认鼠标档只开 1000/1002，**1003 不开 → onMouseOver 一次都不触发**，
 *        鼠标移动时界面没有任何对照，用户无法预览会选中谁；
 *     ② 松开点必须精确命中 1 行高的条目，鼠标稍抖脱靶就**静默无响应**。
 *
 * 本文件锁这两条修正：
 *   A. 菜单/面板挂载期追加 1003（`menuHover` 叶子 + dispatcher.setHover），
 *      卸载只撤 1003，1000/1002 原样（§0.9.4 同档纪律）。
 *   B. 松开脱靶时回落到**按下时命中的条目**（拖选仍优先：consumed 时绝不触发）。
 */

const fs = require('fs');
const path = require('path');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const nodeTest = require('node:test');
  const assert = require('node:assert');
  _describe = nodeTest.describe;
  _test = nodeTest.test;
  _expect = (actual) => ({
    toBe: (exp) => assert.strictEqual(actual, exp),
    toEqual: (exp) => assert.deepStrictEqual(actual, exp),
    toContain: (sub) => assert.ok(String(actual).includes(sub), `expected to contain: ${sub}`),
    toMatch: (re) => assert.match(String(actual), re),
    toHaveLength: (n) => assert.strictEqual(actual.length, n),
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, `${actual} >= ${n}`),
    toBeLessThanOrEqual: (n) => assert.ok(actual <= n, `${actual} <= ${n}`),
    not: {
      toBe: (exp) => assert.notStrictEqual(actual, exp),
      toContain: (sub) => assert.ok(!String(actual).includes(sub), `expected NOT to contain: ${sub}`),
    },
  });
}

const backendRoot = path.resolve(__dirname, '..', '..');
const menuHover = require('../../src/cli/tui/menuHover');
const sgrHold = require('../../src/cli/tui/sgrHold');
const mouse = require('../../src/cli/tui/mouseButtons');

_describe('sgrHold 叶：不完整 SGR 前缀的判定', () => {
  _test('按住不完整前缀；完整序列/文本/Esc 一律放行', () => {
    // 不完整（ConPTY 拆出来的前半段）
    _expect(sgrHold.isPartialSgr('[<')).toBe(true);
    _expect(sgrHold.isPartialSgr('[<32')).toBe(true);
    _expect(sgrHold.isPartialSgr('[<32;10')).toBe(true);
    _expect(sgrHold.isPartialSgr('[<32;10;28')).toBe(true);
    _expect(sgrHold.isPartialSgr('\x1b[<32;10')).toBe(true); // 带 ESC 的形态也认
    // 完整序列（有终结字节 M/m）—— 绝不能被按住
    _expect(sgrHold.isPartialSgr('[<0;10;5M')).toBe(false);
    _expect(sgrHold.isPartialSgr('[<32;10;5m')).toBe(false);
    // 普通文本 / 方向键 / 单独 Esc
    _expect(sgrHold.isPartialSgr('abc')).toBe(false);
    _expect(sgrHold.isPartialSgr('/model')).toBe(false);
    _expect(sgrHold.isPartialSgr('\x1b')).toBe(false);
    _expect(sgrHold.isPartialSgr('\x1b[A')).toBe(false);
    _expect(sgrHold.isPartialSgr('')).toBe(false);
    _expect(sgrHold.isPartialSgr(undefined)).toBe(false);
    // 超长串不桩住（防异常输入堆积）
    _expect(sgrHold.isPartialSgr('[<' + '1'.repeat(40))).toBe(false);
  });

  _test('HOLD_MS 足够覆盖 ConPTY 两次读，又短于人类可感知', () => {
    _expect(sgrHold.HOLD_MS).toBeGreaterThanOrEqual(20);
    _expect(sgrHold.HOLD_MS).toBeLessThanOrEqual(120);
  });
});

_describe('menuHover 叶：闸与字节', () => {
  _test('门控默认开；显式 falsy 关', () => {
    _expect(menuHover.menuHoverEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      _expect(menuHover.menuHoverEnabled({ KHY_MENU_HOVER: v })).toBe(false);
    }
    for (const v of ['1', 'true', 'on']) {
      _expect(menuHover.menuHoverEnabled({ KHY_MENU_HOVER: v })).toBe(true);
    }
  });

  _test('字节只动 1003 一个 bit（不碰 1000/1002 —— 同档纪律）', () => {
    _expect(menuHover.HOVER_ON).toBe('\x1b[?1003h');
    _expect(menuHover.HOVER_OFF).toBe('\x1b[?1003l');
    _expect(menuHover.HOVER_ON).not.toContain('1000');
    _expect(menuHover.HOVER_ON).not.toContain('1002');
    _expect(menuHover.HOVER_OFF).not.toContain('1000');
  });
});

/* ── 用一棵**真 ink 树**验证悬停与点击（门控同 inkRenderSmoke）──────────── */
const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? _describe : _describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[menuHover] render suites skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

describeOrSkip('dispatcher：悬停开关与松开脱靶兜底', () => {
  let ink;
  let rt;

  const fakeStdout = () => {
    const { Writable } = require('stream');
    const s = new Writable({ write(_c, _e, cb) { cb(); } });
    s.columns = 90;
    s.rows = 30;
    s.isTTY = true;
    return s;
  };
  const fakeStdin = () => {
    const { EventEmitter } = require('events');
    const s = new EventEmitter();
    const queue = [];
    s.isTTY = true;
    s.setRawMode = () => s;
    s.setEncoding = () => s;
    s.resume = () => s;
    s.pause = () => s;
    s.ref = () => {};
    s.unref = () => {};
    s.read = () => (queue.length ? queue.shift() : null);
    s.push = (v) => { queue.push(Buffer.from(String(v))); s.emit('readable'); };
    return s;
  };

  // 三行的可点列表：第 0/1/2 行各挂 onClick。
  const mountRows = (onPress) => {
    const React = require('react');
    const { Box, Text } = ink;
    const Comp = () =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        [0, 1, 2].map((i) =>
          React.createElement(
            Box,
            { key: i, onClick: () => onPress(i), onMouseOver: () => onPress(i) },
            React.createElement(Text, null, `row-${i}`)
          )
        )
      );
    const stdout = fakeStdout();
    const inst = ink.render(React.createElement(Comp), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    rt.setApp(inst);
    rt.setRenderStdout(stdout);
    return inst;
  };

  const ctxFor = () => {
    const inst = rt.getInkInstance();
    return { rootNode: inst && inst.rootNode, rows: 30, anchorBottom: false };
  };

  _test('ink 运行时可用', () => {
    rt = require('../../src/cli/tui/inkRuntime');
    rt.registerJsx();
    return rt.loadInk().then(() => {
      ink = rt.get();
      _expect(typeof ink.render).toBe('function');
    });
  });

  _test('setHover(false) 时位移事件不触发 onMouseOver（默认档行为保持）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    const disp = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
    const ctx = ctxFor();
    // 位移事件（1003 才会上报；这里直接喂解析器认得的序列）
    disp.onInput('[<32;5;1M', ctx); // motion with button 32
    disp.onInput('[<32;5;1m', ctx);
    inst.unmount();
    _expect(seen).toEqual([]);
  });

  _test('setHover(true) 后位移事件触发 onMouseOver（菜单期预览）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    const disp = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
    disp.setHover(true);
    const ctx = ctxFor();
    disp.onInput('[<32;5;1M', ctx); // motion → hover row 0
    disp.onInput('[<32;5;2M', ctx); // motion → hover row 1
    inst.unmount();
    _expect(seen).toEqual([0, 1]);
  });

  _test('选择层开着但没在拖：位移仍交悬停层（默认 KHY_SELECT=1 的真实场景）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    // onSelectEvent 接上（= selectEnabled true），但 'move' 在没有手势时返回
    // undefined（未消费）—— 这正是 App.js 现在的契约。
    const disp = mouse.createMouseDispatcher({
      hover: false,
      motionThrottleMs: 0,
      onSelectEvent: (kind) => (kind === 'up' ? true : undefined),
    });
    disp.setHover(true);
    const ctx = ctxFor();
    disp.onInput('[<32;5;1M', ctx); // 鼠标移过第 0 行（没有拖动）
    inst.unmount();
    _expect(seen).toEqual([0]); // 旧行为：[]（被 selectEnabled 无条件吞掉）
  });

  _test('选择层正在拖（move 返回 true）：位移归选择层，不触发悬停', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    const disp = mouse.createMouseDispatcher({
      hover: false,
      motionThrottleMs: 0,
      // 拖动进行中：每一笔 move 都被消费
      onSelectEvent: (kind) => (kind === 'move' || kind === 'up' ? true : undefined),
    });
    disp.setHover(true);
    const ctx = ctxFor();
    disp.onInput('[<32;5;1M', ctx);
    inst.unmount();
    _expect(seen).toEqual([]);
  });

  _test('松开命中：点在行上就触发那一行（回归：正常点击不受影响）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    const disp = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
    const ctx = ctxFor();
    disp.onInput('[<0;5;1M', ctx); // press row 0
    disp.onInput('[<0;5;1m', ctx); // release row 0
    inst.unmount();
    _expect(seen).toEqual([0]);
  });

  _test('松开脱靶：回落到按下命中的行（用户报「单击选不中」的修法）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    const disp = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
    const ctx = ctxFor();
    disp.onInput('[<0;5;1M', ctx); // press row 0
    disp.onInput('[<0;5;29m', ctx); // release 漂到最底（行外）
    inst.unmount();
    _expect(seen).toEqual([0]); // 旧行为：[]（静默丢弃）
  });

  _test('拖选出内容时绝不触发点击（选择优先，回归 §0.9.5a）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    // 接 onSelectEvent：up 返回 true = 选出了非空区间 → 点击必须被让掉。
    const disp = mouse.createMouseDispatcher({
      hover: false,
      motionThrottleMs: 0,
      onSelectEvent: (kind) => kind === 'up',
    });
    const ctx = ctxFor();
    disp.onInput('[<0;5;1M', ctx); // press row 0
    disp.onInput('[<0;5;1m', ctx); // release row 0（同一行）
    inst.unmount();
    _expect(seen).toEqual([]);
  });

  _test('没按在行上就直接放开：不触发（避免误点）', async () => {
    const seen = [];
    const inst = mountRows((i) => seen.push(i));
    await new Promise((r) => setTimeout(r, 150));
    const disp = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
    const ctx = ctxFor();
    disp.onInput('[<0;5;29m', ctx); // press 行外
    disp.onInput('[<0;5;29m', ctx); // release 行外
    inst.unmount();
    _expect(seen).toEqual([]);
  });
});

_describe('接线守卫（源码形状锁）', () => {
  const appSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/ink-components/App.js'), 'utf8'
  );

  _test('菜单/面板挂载期开悬停：setHover + 只写 1003', () => {
    _expect(appSrc).toMatch(/const _menuHoverOn = !!completion\.active \|\| !!paramPanel;/);
    _expect(appSrc).toMatch(/disp\.setHover\(_menuHoverWanted\)/);
    // 只追加/撤销 1003，不重写整组（否则会把 select 档打回 1000）
    _expect(appSrc).toMatch(/process\.stdout\.write\(_menuHoverWanted \? '\\x1b\[\?1003h' : '\\x1b\[\?1003l'\)/);
    _expect(appSrc).toContain('function _menuHoverEnabled(env)');
  });

  _test('App 把 SGR 重组接在按键处理器最前面（鼠标分发之前）', () => {
    _expect(appSrc).toMatch(/_sgrHold\.isPartialSgr\(_in\)/);
    // 按住期间直接 return，绝不让碎片掉进后面的文本编辑
    _expect(appSrc).toMatch(/if \(_sgrHold\.isPartialSgr\(_in\)\) \{[\s\S]{0,400}?return;/);
    // 60ms 兜底放行，不永久吞字节
    _expect(appSrc).toMatch(/_sgrHold\.HOLD_MS\);/);
    _expect(appSrc).toContain("require('../sgrHold')");
  });

  _test('选择层未消费位移时交给悬停（App 的 onSelectEvent 契约）', () => {
    // 'move' 支：没有手势 → 早退（返回 undefined = 未消费）；拖动中 → return true。
    _expect(appSrc).toMatch(/if \(kind === 'move'\) \{[\s\S]{0,600}?if \(!_selectingRef\.current\) \{[\s\S]{0,400}?return;\s*\}/);
    _expect(appSrc).toMatch(/setSelectRegion\(sel\.extendSelection\(_selectRegionRef\.current, pt\.line, pt\.col\)\);\s*\n\s*\/\/ 拖动进行中[\s\S]{0,200}?return true;/);
  });
});
