'use strict';

// 真实渲染断言要量 SGR（加粗高亮），chalk 的色级在模块求值时读一次环境变量 ——
// 必须在本文件 require 任何 ink/chalk 相关模块**之前**设好（tui/AGENTS.md §0.9.6 ②）。
process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

/**
 * completionMenuUx — 斜杠/文件补全菜单的「好用」层回归守卫（2026-10-10）。
 *
 * 客户原话：「除了 /model 外其他的 / 命令都是一闪即过……除了上面的修复还需要美化，
 * 并让它更方便，比如鼠标选中，左右键选择等等」。输出持久化修复见
 * `commandOutputSink.test.js`；本文件锁这一轮**交互与观感**的增量：
 *
 *   1. 鼠标：条目挂 onClick/onMouseOver（mouseButtons.collectLayout 按 props 收命中区），
 *      单击 = 走与回车同一口径的接受逻辑；真实 ink 树 + 真实分发器端到端点一遍。
 *   2. 键盘：左右键 = 斜杠菜单翻页（多页时）/ @文件菜单上下级目录；Home/End 跳首末条。
 *   3. 观感：过滤词在标签里加粗高亮；页脚广告三路入口（回车/左右键/点击），
 *      且页脚退档阶梯与帧高账本保持同源（`menuRowCount` 仍 == 画出行数）。
 *
 * 可在 jest(describe/test/expect)与 `node --test` 双跑(下方 shim)；真实渲染部分
 * 与 inkRenderSmoke 同门（需要 NODE_OPTIONS=--experimental-vm-modules）。
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
    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toBeGreaterThan: (n) => assert.ok(actual > n, `${actual} > ${n}`),
    toBeLessThanOrEqual: (n) => assert.ok(actual <= n, `${actual} <= ${n}`),
    not: {
      toBe: (exp) => assert.notStrictEqual(actual, exp),
      toEqual: (exp) => assert.notDeepStrictEqual(actual, exp),
      toContain: (sub) => assert.ok(!String(actual).includes(sub), `expected NOT to contain: ${sub}`),
      toMatch: (re) => assert.doesNotMatch(String(actual), re),
    },
  });
}

const backendRoot = path.resolve(__dirname, '..', '..');
const CompletionMenu = require('../../src/cli/tui/ink-components/CompletionMenu');
const { visWidth } = require('../../src/cli/tui/runtime/textMeasure');
const stripAnsi = require('../../src/utils/stripAnsi');

_describe('matchRange：过滤词在标签里的高亮区间', () => {
  _test('斜杠 query 剥前导 / 后按子串定位', () => {
    _expect(CompletionMenu.matchRange('/color', '/col')).toEqual({ start: 1, end: 4 });
    _expect(CompletionMenu.matchRange('/help', '/hel')).toEqual({ start: 1, end: 4 });
    // 整词命中也定位（用户把命令打全了）
    _expect(CompletionMenu.matchRange('/model', '/model')).toEqual({ start: 1, end: 6 });
  });

  _test('@文件 query 只拿末段名比（路径前缀不参与）', () => {
    _expect(CompletionMenu.matchRange('cli', '@src/cl')).toEqual({ start: 0, end: 2 });
    _expect(CompletionMenu.matchRange('gateway', '@src/cli/gate')).toEqual({ start: 0, end: 4 });
  });

  _test('空 query / 未命中 / 大小写折叠改变长度 → 一律不高亮（null）', () => {
    _expect(CompletionMenu.matchRange('/help', '')).toBe(null);
    _expect(CompletionMenu.matchRange('/help', '/xyz')).toBe(null);
    _expect(CompletionMenu.matchRange('/help', '帮助')).toBe(null); // 描述命中的候选不加粗
    _expect(CompletionMenu.matchRange('/HELP', '/hel')).toEqual({ start: 1, end: 4 }); // 折叠等长可定位
  });
});

_describe('footerLabel：三路入口的广告位与退档阶梯', () => {
  _test('宽槽：种类 + 页码 + 回车/左右键/Esc/点击 全在', () => {
    const f = CompletionMenu.footerLabel('slash', 2, 22, 76);
    _expect(f).toContain('斜杠命令');
    _expect(f).toContain('第 3/22 页');
    _expect(f).toContain('回车执行');
    _expect(f).toContain('左右键翻页');
    _expect(f).toContain('Esc 取消');
    _expect(f).toContain('点击选中');
    _expect(visWidth(f)).toBeLessThanOrEqual(76);
  });

  _test('@文件菜单说「目录」不说「翻页」', () => {
    const f = CompletionMenu.footerLabel('file', 0, 3, 76);
    _expect(f).toContain('文件');
    _expect(f).toContain('左右键目录');
    _expect(f).not.toContain('左右键翻页');
  });

  _test('任意窄槽：Esc 取消永远在，且不超过内宽', () => {
    // 内宽 ≥10（屏宽 ≥14）时退档阶梯保底「Esc 取消」；再窄只能按列截断，
    // 与 BUG-58 的退档终点一致（completionMenuSize 同口径只测到 20 列）。
    for (const cap of [76, 56, 36, 26, 16, 10]) {
      const f = CompletionMenu.footerLabel('slash', 0, 26, cap);
      _expect(f).toContain('Esc 取消');
      _expect(visWidth(f)).toBeLessThanOrEqual(cap);
    }
    // 窄于 10：仍不许超过内宽（截断档）
    _expect(visWidth(CompletionMenu.footerLabel('slash', 0, 26, 4))).toBeLessThanOrEqual(4);
  });

  _test('不用 ↑↓←→ 字形：Ambiguous 宽度会让账本与 paint 漂移', () => {
    for (const cap of [76, 36, 16]) {
      const f = CompletionMenu.footerLabel('slash', 0, 26, cap);
      _expect(/[↑↓←→]/.test(f)).toBe(false);
    }
  });
});

_describe('接线守卫（源码形状锁：交互两入口必须同口径）', () => {
  const appSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/ink-components/App.js'), 'utf8'
  );
  const previewSrc = fs.readFileSync(
    path.join(backendRoot, 'src/cli/tui/ink-components/PreviewLayout.js'), 'utf8'
  );

  _test('回车与鼠标点击共用 acceptCompletionItem（不分叉）', () => {
    // 单一实现：斜杠 → 清空并执行；文件/子命令 → 补全进缓冲区。
    _expect(appSrc).toMatch(/const acceptCompletionItem = React\.useCallback\(/);
    _expect(appSrc).toContain('acceptCompletionItem(menu, item, menuValue);');
    // 鼠标入口把同一函数接过去（2026-10-10 起前面多一道参数面板闸：
    // 带可调参数的斜杠命令先开面板并清空输入，闸不过才落回接受逻辑）。
    // 用「三件事的先后顺序」断言而非精确窗口——注释长短不该让守卫变红。
    _expect(appSrc).toMatch(
      /onItemPress: \(idx\) => \{[\s\S]{0,400}?openParamPanel\(item\.value, value\)[\s\S]{0,200}?acceptCompletionItem\(completion, item, value\)/
    );
  });

  _test('菜单 props 带上 query 与两个鼠标回调', () => {
    _expect(appSrc).toMatch(/query: \(\(\) => \{[\s\S]{0,220}return value\.slice\(s, e\)/);
    _expect(appSrc).toContain('onItemHover: (idx) => setSelectedIndex(idx),');
  });

  _test('PreviewLayout 原样转发（宽终端菜单交互不分叉）', () => {
    _expect(previewSrc).toContain('query: completionQuery,');
    _expect(previewSrc).toContain('onItemPress: onCompletionItemPress,');
    _expect(previewSrc).toContain('onItemHover: onCompletionItemHover,');
    _expect(appSrc).toContain('completionQuery: _completionMenuProps ? _completionMenuProps.query');
  });

  _test('左右键与 Home/End 在菜单分支里有绑定', () => {
    _expect(appSrc).toMatch(/if \(key\.leftArrow \|\| key\.rightArrow\) \{/);
    _expect(appSrc).toContain("if (menu.kind === 'file') {");
    _expect(appSrc).toContain('const parent = cut <= 0 ? \'@\' : `${stripped.slice(0, cut)}/`;');
    _expect(appSrc).toMatch(/if \(key\.home\) \{\s*setSelectedIndex\(0\)/);
    _expect(appSrc).toMatch(/if \(key\.end\) \{\s*setSelectedIndex\(menu\.items\.length - 1\)/);
  });
});

/* ── 真实渲染 + 真实鼠标分发（门控同 inkRenderSmoke）──────────────────────── */
const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? _describe : _describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[completionMenuUx] render/mouse suites skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const SLASH = {
  active: true,
  kind: 'slash',
  start: 0,
  end: 5,
  items: [
    { value: '/help', label: '/help', desc: '显示帮助与命令列表' },
    { value: '/model', label: '/model', desc: '切换 AI 模型' },
  ],
};

describeOrSkip('CompletionMenu 真实渲染：高亮 + 页脚 + 鼠标命中', () => {
  let ink;
  let rt;

  const fakeStdout = () => {
    const { Writable } = require('stream');
    let buffer = '';
    const s = new Writable({ write(c, _e, cb) { buffer += c.toString(); cb(); } });
    s.columns = 80;
    s.rows = 24;
    s.isTTY = true;
    s.getBuffer = () => buffer;
    return s;
  };
  const fakeStdin = () => {
    const { EventEmitter } = require('events');
    const s = new EventEmitter();
    s.isTTY = true;
    s.setRawMode = () => s;
    s.setEncoding = () => s;
    s.resume = () => s;
    s.pause = () => s;
    s.ref = () => {};
    s.unref = () => {};
    s.read = () => null;
    return s;
  };

  _test('ink 运行时可用', () => {
    rt = require('../../src/cli/tui/inkRuntime');
    rt.registerJsx();
    return rt.loadInk().then(() => {
      ink = rt.get();
      _expect(typeof ink.render).toBe('function');
    });
  });

  _test('query 命中段加粗；页脚带三路入口广告', async () => {
    const stdout = fakeStdout();
    const inst = ink.render(
      require('react').createElement(CompletionMenu, {
        completion: SLASH, selectedIndex: 0, marginLeft: 0, page: 0, cols: 80, maxRows: 0,
        query: '/hel',
      }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    const frame = stdout.getBuffer();
    inst.unmount();
    const plain = stripAnsi(frame);
    // 两条命令都画出来，页脚是新的三路入口文案
    _expect(plain).toContain('/help');
    _expect(plain).toContain('/model');
    _expect(plain).toContain('左右键翻页');
    _expect(plain).toContain('点击选中');
    // 命中段 `/hel` 被 bold 包住 —— 帧里应出现 bold SGR 且其后紧跟 hel
    _expect(frame).toMatch(/\x1b\[1mhel/);
  });

  _test('无 query 时不加粗（旧行为字节锁的渲染侧对应）', async () => {
    const stdout = fakeStdout();
    const inst = ink.render(
      require('react').createElement(CompletionMenu, {
        completion: SLASH, selectedIndex: 0, marginLeft: 0, page: 0, cols: 80, maxRows: 0,
      }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    const frame = stdout.getBuffer();
    inst.unmount();
    _expect(frame).not.toMatch(/\x1b\[1mhel/); // 没有命中段就不该有围绕它的 bold
  });

  _test('鼠标点击第二条 = onItemPress(1)（真实 ink 树 + 仓库自己的分发器）', async () => {
    const mouse = require('../../src/cli/tui/mouseButtons');
    const stdout = fakeStdout();
    const presses = [];
    const inst = ink.render(
      require('react').createElement(CompletionMenu, {
        completion: SLASH, selectedIndex: 0, marginLeft: 0, page: 0, cols: 80, maxRows: 0,
        query: '/hel',
        onItemPress: (i) => presses.push(i),
        onItemHover: () => {},
      }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    // 与 app.js 同一顺序：实例注册后 collectLayout 才拿得到 rootNode。
    rt.setApp(inst);
    rt.setRenderStdout(stdout);
    await new Promise((r) => setTimeout(r, 150));

    const inkInst = rt.getInkInstance();
    _expect(inkInst && inkInst.rootNode).toBeTruthy();
    const root = inkInst.rootNode;
    const layout = mouse.collectLayout(root);
    // 两条条目各是一个命中区（高度 1 行、可点）
    _expect(layout.items.length).toBe(2);
    _expect(typeof layout.items[0].onClick).toBe('function');

    const it = layout.items[1];
    const col = it.x + Math.floor(it.width / 2);
    const row = it.y + Math.floor(it.height / 2);
    const dispatch = mouse.createMouseDispatcher({ hover: false, motionThrottleMs: 0 }).onInput;
    dispatch(`[<0;${col + 1};${row + 1}M`, { rootNode: root, rows: 24, anchorBottom: false });
    dispatch(`[<0;${col + 1};${row + 1}m`, { rootNode: root, rows: 24, anchorBottom: false });
    inst.unmount();
    _expect(presses).toEqual([1]);
  });

  _test('帧高账本仍 == 画出行数（新页脚没有偷行）', async () => {
    const stdout = fakeStdout();
    const props = { completion: SLASH, selectedIndex: 0, marginLeft: 0, page: 0, cols: 80, maxRows: 0, query: '/hel' };
    const inst = ink.render(
      require('react').createElement(CompletionMenu, props),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    const painted = stripAnsi(stdout.getBuffer())
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
    inst.unmount();
    // 边框 2 + 2 条 + 页脚 1
    _expect(CompletionMenu.menuRowCount(props)).toBe(painted);
  });

  // 类目着色（2026-10-11）：未选中行前景色随 item.category 走，选中行黑字青底不变。
  // 断言锚到「SGR 紧贴 marker+label」的行内形态——边框 borderColor:'gray' 本身恒发
  // \x1b[90m，整帧裸断「无 90」永远不成立，必须锚行内容才分得清边框灰与行灰。
  const CATEGORIZED = {
    active: true,
    kind: 'slash',
    start: 0,
    end: 6,
    items: [
      { value: '/vault', label: '/vault', desc: '密钥库', category: 'security' },
      { value: '/study', label: '/study', desc: '学习', category: 'default' },
      { value: '/help', label: '/help', desc: '显示帮助与命令列表' },
    ],
  };

  _test('类目着色：security→31、default→90、选中行黑字青底不随类变', async () => {
    const stdout = fakeStdout();
    // 选中第 3 条（无 category 键）：31/90 出现在前两条未选中行，
    // 选中行以「无类也照样黑字青底」证明 selected 分支完全绕开类色。
    const inst = ink.render(
      require('react').createElement(CompletionMenu, {
        completion: CATEGORIZED, selectedIndex: 2, marginLeft: 0, page: 0, cols: 80, maxRows: 0,
      }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    const frame = stdout.getBuffer();
    inst.unmount();
    _expect(frame).toContain('\x1b[31m  /vault');
    _expect(frame).toContain('\x1b[90m  /study');
    // 黑字青底是两个独立 SGR（bg 在前），非 30;46 合并形式
    _expect(frame).toMatch(/\x1b\[46m\x1b\[30m› \/help/);
  });

  _test('无 category 键的 descriptor（等价 @file/slash-sub 形态）仍整行 36', async () => {
    const stdout = fakeStdout();
    const inst = ink.render(
      require('react').createElement(CompletionMenu, {
        completion: {
          active: true,
          kind: 'file',
          start: 0,
          end: 4,
          items: [
            { value: '@src/', label: 'src/', desc: '目录', isDir: true },
            { value: '@tests/', label: 'tests/', desc: '目录', isDir: true },
          ],
        },
        selectedIndex: -1, marginLeft: 0, page: 0, cols: 80, maxRows: 0,
      }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((r) => setTimeout(r, 150));
    const frame = stdout.getBuffer();
    inst.unmount();
    _expect(frame).toContain('\x1b[36m  src/');
    _expect(frame).toContain('\x1b[36m  tests/');
    _expect(frame).not.toContain('\x1b[31m');
  });

  _test('门控关（KHY_MENU_CATEGORY_COLOR=0）：所有行回退 36，无类色', async () => {
    process.env.KHY_MENU_CATEGORY_COLOR = '0';
    try {
      const stdout = fakeStdout();
      const inst = ink.render(
        require('react').createElement(CompletionMenu, {
          completion: CATEGORIZED, selectedIndex: 2, marginLeft: 0, page: 0, cols: 80, maxRows: 0,
        }),
        { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
      );
      await new Promise((r) => setTimeout(r, 150));
      const frame = stdout.getBuffer();
      inst.unmount();
      _expect(frame).toContain('\x1b[36m  /vault');
      _expect(frame).toContain('\x1b[36m  /study');
      _expect(frame).not.toContain('\x1b[31m');
      _expect(frame).not.toContain('\x1b[90m  /study');
      // 选中行黑字青底与门控无关
      _expect(frame).toMatch(/\x1b\[46m\x1b\[30m› \/help/);
    } finally {
      delete process.env.KHY_MENU_CATEGORY_COLOR;
    }
  });
});
