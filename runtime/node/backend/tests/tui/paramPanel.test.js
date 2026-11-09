'use strict';

// 参数面板回归守卫（2026-10-10 第三轮：/命令形成面板，多参数上下左右选择输入）。
//
// 覆盖三层：
//   1. commandParamSpecs 规格真源：CURATED 逐个核对 + 经典 REPL 二级菜单派生 +
//      组装命令行 + 门控；
//   2. ParamPanel 交互与渲染：候选窗口/文本光标的纯函数、真实渲染（参数行 +
//      候选列表 + 预览 + 键位提示）、真实鼠标分发点行换值；
//   3. App 接线：菜单回车与点击对带参命令先开面板、面板挂载期 App 顶层
//      yield、两条布局路径都渲染。
//
// 可在 jest(describe/test/expect)与 `node --test` 双跑(下方 shim)；真实渲染部分
// 与 inkRenderSmoke 同门（需要 NODE_OPTIONS=--experimental-vm-modules）。

process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

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
    toBeGreaterThan: (n) => assert.ok(actual > n, `${actual} > ${n}`),
    toBeLessThanOrEqual: (n) => assert.ok(actual <= n, `${actual} <= ${n}`),
    toBeLessThan: (n) => assert.ok(actual < n, `${actual} < ${n}`),
    not: {
      toBe: (exp) => assert.notStrictEqual(actual, exp),
      toEqual: (exp) => assert.notDeepStrictEqual(actual, exp),
      toContain: (sub) => assert.ok(!String(actual).includes(sub), `expected NOT to contain: ${sub}`),
      toMatch: (re) => assert.doesNotMatch(String(actual), re),
    },
  });
}

const backendRoot = path.resolve(__dirname, '..', '..');
const specs = require('../../src/cli/tui/commandParamSpecs');
const ParamPanel = require('../../src/cli/tui/ink-components/ParamPanel');
const stripAnsi = require('../../src/utils/stripAnsi');

_describe('commandParamSpecs：规格真源', () => {
  _test('CURATED 档：核对过的命令带中文标签与真值', () => {
    const color = specs.specsFor('/color');
    _expect(color).toHaveLength(1);
    _expect(color[0].label).toBe('会话强调色');
    _expect(color[0].type).toBe('choice');
    // 值来自 sessionColor.AGENT_COLORS（与 agent 配色同一份）+ default 重置。
    _expect(color[0].choices.map((c) => c.value)).toEqual([
      'blue', 'green', 'orange', 'purple', 'red', 'cyan', 'yellow', 'magenta', 'default',
    ]);
    _expect(specs.specsFor('/lang')[0].choices.map((c) => c.value)).toEqual(['zh', 'en', 'auto']);
    _expect(specs.specsFor('/intent')[0].choices.map((c) => c.value)).toEqual(['on', 'off', 'show']);
    _expect(specs.specsFor('/shell')[0].type).toBe('text');
    _expect(specs.specsFor('/rewind')[0].optional).toBe(true);
  });

  _test('派生档：经典 REPL 二级菜单的同一真源自动覆盖', () => {
    const gw = specs.specsFor('/gateway');
    _expect(gw).toHaveLength(1);
    _expect(gw[0].label).toBe('子命令');
    _expect(gw[0].choices.length).toBeGreaterThan(10);
    _expect(gw[0].choices.some((c) => c.value === 'status')).toBe(true);
    // 大小写/前导斜杠不拘
    _expect(specs.specsFor('gateway')).toHaveLength(1);
    _expect(specs.specsFor('/GATEWAY')).toHaveLength(1);
  });

  _test('无规格 → 空数组（调用方直接执行，不弹面板）', () => {
    for (const c of ['/model', '/help', '/clear', '/xyz', '']) {
      _expect(specs.specsFor(c)).toEqual([]);
    }
  });

  _test('门控 KHY_SLASH_PARAM_PANEL：默认开，显式 falsy 全关', () => {
    _expect(specs.specsFor('/gateway', {})).toHaveLength(1);
    _expect(specs.panelEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'off', 'no']) {
      _expect(specs.panelEnabled({ KHY_SLASH_PARAM_PANEL: v })).toBe(false);
      _expect(specs.specsFor('/gateway', { KHY_SLASH_PARAM_PANEL: v })).toEqual([]);
    }
  });

  _test('assemble：空值跳过，文本原样接上', () => {
    _expect(specs.assemble('/gateway', specs.specsFor('/gateway'), ['status'])).toBe('/gateway status');
    _expect(specs.assemble('/gateway', specs.specsFor('/gateway'), [''])).toBe('/gateway');
    _expect(specs.assemble('/color', specs.specsFor('/color'), ['blue'])).toBe('/color blue');
    _expect(specs.assemble('/shell', specs.specsFor('/shell'), ['ls -la'])).toBe('/shell ls -la');
    _expect(specs.assemble('/rewind', specs.specsFor('/rewind'), ['  '])).toBe('/rewind');
    // 前导斜杠不拘：传 'gateway' 也组装出 '/gateway status'
    _expect(specs.assemble('gateway', specs.specsFor('gateway'), ['status'])).toBe('/gateway status');
  });

  _test('多规格按序组装（instructions：子命令 + id）', () => {
    const twoSpecs = [
      { name: 'sub', label: '动作', type: 'choice', choices: [{ name: '批准', value: 'approve' }] },
      { name: 'id', label: '条目', type: 'text', optional: true },
    ];
    _expect(specs.assemble('/instructions', twoSpecs, ['approve', 'abc123'])).toBe('/instructions approve abc123');
    _expect(specs.assemble('/instructions', twoSpecs, ['approve', ''])).toBe('/instructions approve');
  });
});

_describe('ParamPanel 纯函数', () => {
  _test('choiceWindow：少于一窗全画；多于则围绕高亮滚动且不越界', () => {
    const few = [{ value: 'a' }, { value: 'b' }];
    _expect(ParamPanel.choiceWindow(few, 1).list).toHaveLength(2);
    const many = Array.from({ length: 23 }, (_, i) => ({ value: String(i) }));
    const w0 = ParamPanel.choiceWindow(many, 0);
    _expect(w0.start).toBe(0);
    _expect(w0.list).toHaveLength(ParamPanel.CHOICE_WINDOW);
    const wMid = ParamPanel.choiceWindow(many, 11);
    _expect(wMid.list[0].i).toBeGreaterThan(0);
    _expect(wMid.list[wMid.list.length - 1].i).toBeLessThan(23);
    const wEnd = ParamPanel.choiceWindow(many, 22);
    _expect(wEnd.start + wEnd.list.length).toBe(23); // 贴尾不越界
  });

  _test('textView：光标方块落在 caret 处并钳住越界值', () => {
    _expect(ParamPanel.textView('abc', 1)).toBe('a█bc');
    _expect(ParamPanel.textView('abc', 0)).toBe('█abc');
    _expect(ParamPanel.textView('abc', 99)).toBe('abc█');
    _expect(ParamPanel.textView('', 0)).toBe('█');
  });
});

_describe('接线守卫（源码形状锁）', () => {
  const appSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/ink-components/App.js'), 'utf8'
  );
  const layoutSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/ink-components/regionLayout.js'), 'utf8'
  );

  _test('菜单回车/点击：带参命令先开面板，无规格才直接执行', () => {
    // 回车分支：开面板 + 清空输入（不清会把 `/gateway` 留在框里，下一条命令接成
    // `/gateway/instructions` —— PTY 实测形态）。
    _expect(appSrc).toMatch(
      /if \(menu\.kind === 'slash' && item && openParamPanel\(item\.value, menuValue\)\) \{[\s\S]{0,120}?textInput\.setText\('', 0\);/
    );
    // 鼠标点击分支同一道闸（顺序断言：开面板 → 清空 → 落回接受逻辑）。
    _expect(appSrc).toMatch(
      /onItemPress: \(idx\) => \{[\s\S]{0,400}?openParamPanel\(item\.value, value\)[\s\S]{0,200}?acceptCompletionItem\(completion, item, value\)/
    );
  });

  _test('面板挂载期 App 顶层 useInput yield；awaitingUserChoice 计入', () => {
    _expect(appSrc).toMatch(/if \(paramPanel\) \{\s*return;\s*\}/);
    _expect(appSrc).toContain('!!formFlow || khyosOpen || !!paramPanel');
  });

  _test('regionLayout 登记 paramPanel（独占输入、hideChrome=false）', () => {
    _expect(layoutSrc).toContain(
      'paramPanel: { region: REGION.OVERLAY, ownsInput: true, hideChrome: false },'
    );
    _expect(appSrc).toContain('paramPanel: !!paramPanel,');
  });

  _test('两条布局路径都渲染面板（宽窄终端不分叉）', () => {
    const mounts = appSrc.match(/h\(ParamPanel, \{/g) || [];
    _expect(mounts).toHaveLength(2);
    _expect(appSrc).toContain("const ParamPanel = require('./ParamPanel');");
  });

  _test('resolveParamPanel 把组装行交回 handleSubmit（既有正门）；Esc 放回原文', () => {
    _expect(appSrc).toMatch(/const resolveParamPanel = React\.useCallback\(/);
    // 顺序断言：先关面板 → 有组装行就交回 handleSubmit → 否则（Esc）放回原文。
    _expect(appSrc).toMatch(
      /setParamPanel\(null\);[\s\S]{0,240}?if \(line && String\(line\)\.trim\(\)\) \{[\s\S]{0,240}?handleSubmit\(String\(line\)\.trim\(\)\);[\s\S]{0,400}?textInput\.setText\(back, back\.length\)/
    );
  });
});

/* ── 真实渲染 + 真实鼠标分发（门控同 inkRenderSmoke）──────────────────────── */
const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? _describe : _describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[paramPanel] render/mouse suites skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

describeOrSkip('ParamPanel 真实渲染与鼠标', () => {
  let ink;
  let rt;

  const fakeStdout = () => {
    const { Writable } = require('stream');
    let buffer = '';
    const s = new Writable({ write(c, _e, cb) { buffer += c.toString(); cb(); } });
    s.columns = 90;
    s.rows = 30;
    s.isTTY = true;
    s.getBuffer = () => buffer;
    return s;
  };
  // ink 的 useInput 走 stdin 的 'readable' + read()：队列 + push 与仓库其余
  // 渲染测试（keyHandlerFreshClosure）同一形状。
  const fakeStdin = () => {
    const { EventEmitter } = require('events');
    const stream = new EventEmitter();
    const queue = [];
    stream.isTTY = true;
    stream.setRawMode = () => stream;
    stream.setEncoding = () => stream;
    stream.resume = () => stream;
    stream.pause = () => stream;
    stream.ref = () => {};
    stream.unref = () => {};
    stream.read = () => (queue.length ? queue.shift() : null);
    stream.push = (s) => {
      queue.push(Buffer.from(String(s)));
      stream.emit('readable');
    };
    return stream;
  };

  _test('ink 运行时可用', () => {
    rt = require('../../src/cli/tui/inkRuntime');
    rt.registerJsx();
    return rt.loadInk().then(() => {
      ink = rt.get();
      _expect(typeof ink.render).toBe('function');
    });
  });

  const GW = specs.specsFor('/gateway');

  _test('渲染：头带、参数行、候选窗口、预览带、键帽都在', async () => {
    const stdout = fakeStdout();
    const inst = ink.render(
      require('react').createElement(ParamPanel, {
        cmd: '/gateway', specs: GW, onResolve: () => {},
      }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    const plain = stripAnsi(stdout.getBuffer());
    inst.unmount();
    // 头带：命令 + 参数个数（2026-10-10 视觉细化后的形态）
    _expect(plain).toContain('调整参数 /gateway');
    _expect(plain).toContain('1 个参数');
    // 参数行：标签列 + 芯片值
    _expect(plain).toContain('子命令');
    _expect(plain).toContain('status');
    // 分隔线 + 预览带（提示符 ❯ + 组装行）
    _expect(plain).toMatch(/─{10,}/);
    _expect(plain).toContain('❯ /gateway');
    // 键帽：键名与说明分开着墨
    _expect(plain).toContain('↑↓');
    _expect(plain).toContain('选参数');
    _expect(plain).toContain('←→');
    _expect(plain).toContain('调值');
    _expect(plain).toContain('⏎');
    _expect(plain).toContain('执行');
    _expect(plain).toContain('esc');
    _expect(plain).toContain('返回');
    // 候选超一窗时如实报窗口范围（23 个子命令）
    _expect(plain).toMatch(/候选值 1-5\/23/);
  });

  _test('Esc 返回不执行（onResolve(null)）', async () => {
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    let resolved = 'unset';
    const inst = ink.render(
      require('react').createElement(ParamPanel, {
        cmd: '/color', specs: specs.specsFor('/color'), onResolve: (v) => { resolved = v; },
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    stdin.push('\x1b'); // Esc
    await new Promise((r) => setTimeout(r, 150));
    inst.unmount();
    _expect(resolved).toBe(null);
  });

  _test('回车执行：把组装命令行交回 onResolve', async () => {
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    let resolved = 'unset';
    const inst = ink.render(
      require('react').createElement(ParamPanel, {
        cmd: '/color', specs: specs.specsFor('/color'), onResolve: (v) => { resolved = v; },
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    stdin.push('\r'); // 全空 → 组装出裸命令（默认行为），不拦
    await new Promise((r) => setTimeout(r, 150));
    inst.unmount();
    _expect(resolved).toBe('/color');
  });

  _test('←→ 调值后回车：组装出带值的命令行', async () => {
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    let resolved = 'unset';
    const inst = ink.render(
      require('react').createElement(ParamPanel, {
        cmd: '/intent', specs: specs.specsFor('/intent'), onResolve: (v) => { resolved = v; },
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    stdin.push('\x1b[C'); // → 从「未选」前进到第一项 on
    await new Promise((r) => setTimeout(r, 120));
    stdin.push('\r');
    await new Promise((r) => setTimeout(r, 150));
    inst.unmount();
    _expect(resolved).toBe('/intent on');
  });

  _test('鼠标点选项行：选中并把值切到下一个', async () => {
    const mouse = require('../../src/cli/tui/mouseButtons');
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    let resolved = 'unset';
    const inst = ink.render(
      require('react').createElement(ParamPanel, {
        cmd: '/lang', specs: specs.specsFor('/lang'), onResolve: (v) => { resolved = v; },
      }),
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
    );
    rt.setApp(inst);
    rt.setRenderStdout(stdout);
    await new Promise((r) => setTimeout(r, 150));

    const inkInst = rt.getInkInstance();
    _expect(inkInst && inkInst.rootNode).toBeTruthy();
    const layout = mouse.collectLayout(inkInst.rootNode);
    _expect(layout.items.length).toBeGreaterThan(0);
    // 第一个命中区就是第一个参数行；点它 → 值从空切到第一项（zh）。
    const it = layout.items[0];
    const col = it.x + Math.floor(it.width / 2);
    const row = it.y + Math.floor(it.height / 2);
    const dispatch = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 }).onInput;
    dispatch(`[<0;${col + 1};${row + 1}M`, { rootNode: inkInst.rootNode, rows: 30, anchorBottom: false });
    dispatch(`[<0;${col + 1};${row + 1}m`, { rootNode: inkInst.rootNode, rows: 30, anchorBottom: false });
    await new Promise((r) => setTimeout(r, 120));
    // 点完直接回车执行 → 组装出的命令行应带上刚切的值
    stdin.push('\r');
    await new Promise((r) => setTimeout(r, 150));
    inst.unmount();
    _expect(resolved).toBe('/lang zh');
  });
});
