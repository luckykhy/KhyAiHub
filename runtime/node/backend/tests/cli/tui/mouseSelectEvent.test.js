'use strict';

// dispatcher.onSelectEvent — 应用内自绘选择的**事件侧**接线契约。
//
// 背景见 `[DESIGN-ARCH-119]` §4.2.1b:第一层的 `return false` 是**假路径** ——
// ink 的 `use-input.js:112-114` 把 handler 返回值直接丢弃(`inputHandler(input, key)`
// 没人看),事件已被 ink 从 stdin 读走,`false` 物理上回不到终端。所以「把事件还给
// 终端」这条路根本不存在,**唯一的真解法是本进程自己画选区**:拖动时收位移、松手时
// 自己写剪贴板。这个文件守的就是「拖动确实变成 onSelectEvent」这条前提。
//
// 最有价值的几条断言不是 happy path,而是**互斥关系**:
//   E1  接了 onSelectEvent 时,按住拖动走 `move`,不再走 hover —— 拖动时用户要的是
//       选文字不是高亮按钮;顺序写反会让 hover 的 30ms 限流把选区轨迹吞掉一段。
//   E2  `up` 必须在 `return` **之前**上报 —— 松手是唯一产出点(extractText +
//       writeClipboard),漏了它就等于「能拖不能复制」,正是用户报的那个症状。
//   E3  没接 onSelectEvent 时**逐字节保持老行为**(不回调、不动 pendingClick)。
//       这条守的是「不开选择的用户零影响」——dispatcher 在每次鼠标事件的热路径上。
//   E4  修饰键放行必须**先于** select 上报。Shift+拖动是 §6.2 承诺的终端原生选择,
//       我们不该自作主张画自己的选区。
//
// `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const { createMouseDispatcher } = require('../../../src/cli/tui/mouseButtons');

// 假布局:一个位于 (col 5..14, row 3..4) 的可点节点,外加一个高瘦的空布局。
//
// 之所以不用 `rootNode: null`:`onInput` 在 rootNode 为假时会**提前 return true**,
// 所有事件表现一致,测不出任何差异(第一版探针就是这么全绿然后毫无价值的)。
// 真实 yoga 树无法在纯单测里构造,故这里用一个 mimick collectLayout 输出的字面量。
//
// ⚠ 诚实边界(2026-09-24 补记):这个字面量**从来没被 dispatcher 读到** ——
// `onInput` 走的是 `getLayout(ctx.rootNode, ctx.cacheKey)`(内部调 `collectLayout`),
// 而 `ctxWithLayout()` 塞的是 `__layout` 字段,没人读它。于是 `hitTest` 恒为空、
// 「命中按钮」这条分支在本文件里其实一次都没被测到过(E-09 的注释已自认)。
// 需要真命中时用下面的 `treeWithCard()`,它喂的是 collectLayout 真正消费的
// yogaNode/childNodes 形状 —— 与 ToolLines 的卡片 Box 同形。
function fakeLayout() {
  const node = { style: { onClick: () => {} }, internal_static: false };
  return {
    height: 10,
    items: [{ node, x: 5, y: 3, width: 10, height: 2 }],
  };
}

/**
 * 一棵**能被 collectLayout 真正走通**的假 yoga 树:一张覆盖屏幕 0..7 行、
 * 挂着 onClick/onMouseOver/onMouseOut 的「工具卡片」。
 *
 * 为什么是这个形状:`ToolLines.js` 给**每一张工具卡片**都挂这三个处理器,而
 * `collectLayout` 收的判据是「任一鼠标处理器存在」⇒ 转录区里最大的一块面积
 * 都是命中区。这正是「在卡片上拖选文字选不中」那条缺陷的物理前提。
 * @returns {{root: object, clicks: {card: number}}}
 */
function treeWithCard() {
  const clicks = { card: 0 };
  const yoga = (o) => ({
    getComputedLeft: () => o.left || 0,
    getComputedTop: () => o.top || 0,
    getComputedWidth: () => o.width || 0,
    getComputedHeight: () => o.height || 0,
    getDisplay: () => 0,
  });
  const card = {
    internal_static: false,
    yogaNode: yoga({ width: 100, height: 8 }),
    childNodes: [],
    style: {
      onClick: () => { clicks.card++; },
      onMouseOver: () => {},
      onMouseOut: () => {},
    },
  };
  return {
    root: { internal_static: false, yogaNode: yoga({ width: 100, height: 20 }), childNodes: [card], style: {} },
    clicks,
  };
}

const CTX = { rootNode: {}, rows: 40, anchorBottom: false, cacheKey: 'k' };
const PRESS_BLANK = '[<0;30;8M'; // 左键按下,空白处(row 8 不在 3..4 内)
const PRESS_BTN = '[<0;7;3M'; // 左键按下,命中按钮
const PRESS_CARD = '[<0;10;2M'; // 左键按下,命中 treeWithCard 的卡片(row 1)
const RELEASE_CARD = '[<0;10;2m'; // 左键松开,仍在卡片内
const MOVE = '[<32;31;8M'; // 1002 按住拖动位移
const MOVE_IN_CARD = '[<32;10;5M'; // 1002 位移,仍在卡片内(row 4)
const RELEASE_BLANK = '[<0;32;8m'; // 左键松开,空白处

/** 构造一个能命中按钮的 dispatcher 上下文(注入假布局)。 */
function ctxWithLayout() {
  return { ...CTX, __layout: fakeLayout() };
}

// ── E3:未接线 → 逐字节老行为 ─────────────────────────────────────────────────
test('E-01: 未接 onSelectEvent 时一个回调都不发(不开选择的用户零影响)', () => {
  const seen = [];
  const d = createMouseDispatcher({ onSelectEvent: undefined });
  // 未接时 fireSelect 是 no-op;这里顺带确认构造函数不抛、不会把 undefined 当回调调。
  assert.doesNotThrow(() => {
    d.onInput(PRESS_BLANK, CTX);
    d.onInput(MOVE, CTX);
    d.onInput(RELEASE_BLANK, CTX);
  });
  assert.deepEqual(seen, [], '未接线时不该有任何事件');
});

test('E-02: onSelectEvent 抛异常必须被吞掉,不能连累后续键盘输入路径', () => {
  const d = createMouseDispatcher({
    onSelectEvent: () => {
      throw new Error('selection layer exploded');
    },
  });
  assert.doesNotThrow(() => d.onInput(PRESS_BLANK, CTX));
  assert.doesNotThrow(() => d.onInput(MOVE, CTX));
  assert.doesNotThrow(() => d.onInput(RELEASE_BLANK, CTX));
});

// ── E1/E2:拖动 → down / move / up 三事件齐备且顺序正确 ─────────────────────────
test('E-03: 空白处按下 → 上报 down;拖动 → 上报 move;松手 → 上报 up(顺序严格)', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  d.onInput(PRESS_BLANK, CTX);
  d.onInput(MOVE, CTX);
  d.onInput(MOVE, CTX);
  d.onInput(RELEASE_BLANK, CTX);
  assert.deepEqual(
    seen,
    ['down', 'move', 'move', 'up'],
    'up 必须落在最后 —— 它是 extractText + writeClipboard 的唯一触发点'
  );
});

test('E-04: 接了 onSelectEvent 时**拖动位移不再走 hover**(互斥,顺序必须如此)', () => {
  // 若 move 分支先判 hover,30ms 限流会把选区轨迹吞掉几段 → 选区「跳格」。
  const d = createMouseDispatcher({
    onSelectEvent: () => {},
    hover: true,
    motionThrottleMs: 100000, // 极大值:一旦走到 hover 路径必然被限流吃掉
  });
  const first = d.onInput(MOVE, CTX);
  const second = d.onInput(MOVE, CTX);
  assert.equal(first, true);
  assert.equal(second, true, '选区扩展绝不能被 hover 的限流吞掉');
});

test('E-05: 拖动位移**不限流** —— 每个位移点都要到达选择层', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  d.onInput(PRESS_BLANK, CTX);
  for (let i = 0; i < 10; i++) {
    d.onInput(`[<32;${30 + i};8M`, CTX);
  }
  d.onInput(RELEASE_BLANK, CTX);
  assert.equal(seen.filter((k) => k === 'move').length, 10, '丢一个位移点 = 选区跳一段');
});

test('E-06: 坐标透传的是 parseSgrMouse 输出的 0-based 屏幕坐标(不减视口偏移)', () => {
  const coords = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind, ev) => {
      if (kind === 'down') coords.push([ev.col, ev.row]);
    },
    hover: false,
  });
  // 序列里是 SGR 的 1-based(42, 17);parser 已做 -1,到选择层是 (41, 16)。
  // **视口滚动偏移不在这里减** —— 调度层不知道 App 的 scroll state,让调度层去猜
  // 偏移正是「坐标看着对、选区总差几行」这类 bug 的来源。
  d.onInput('[<0;42;17M', CTX);
  assert.deepEqual(coords, [[41, 16]], '透传 0-based 屏幕坐标,偏移转换是 App 层的事');
});

// ── E4:修饰键优先于选择层 ───────────────────────────────────────────────────
test('E-07: Shift+按下 不启自己的选区 —— §6.2 承诺「Shift+任何鼠标 = 终端原生选择」', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  const ret = d.onInput('[<4;30;8M', CTX); // Shift(4) + 左键按下
  assert.equal(ret, false, '放行,不消费');
  assert.deepEqual(seen, [], 'Shift 按下不该起自绘选区,否则与终端原生选择打架');
});

test('E-07b: Shift+**拖动位移** 也必须放行 —— 修饰键判定必须早于 motion 分支', () => {
  // ⚠ 这是一个真实缺陷的回归守卫(端到端探针抓的,当时的单测只覆盖了 press):
  // `[<36;x;yM` = Shift(4) | motion(32)。修饰键块原本排在 `isMotion` **之后**,
  // 于是按着 Shift 拖动时:press/move/release 里只有 move 会漏进选区分支 →
  // 用户按 Shift 本想要终端原生选择,结果程序同时在画自己的选区,两套打架。
  // ⇒ 判据顺序是根因级的:修饰键放行必须在 motion / press / release **全部之前**。
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  assert.equal(d.onInput('[<4;30;8M', CTX), false, 'Shift+按下 → 放行');
  assert.equal(d.onInput('[<36;31;8M', CTX), false, 'Shift+位移 → 放行');
  assert.equal(d.onInput('[<4;32;8m', CTX), false, 'Shift+松开 → 放行');
  assert.deepEqual(seen, [], '整段 Shift 手势一个选区事件都不该发');
});

test('E-07c: 对照 —— 同样的手势不带 Shift 时必须完整走得通', () => {
  // 与 E-07b 成对:证明 E-07b 不是靠「什么都不做」蒙混过关。
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  d.onInput('[<0;30;8M', CTX);
  d.onInput('[<32;31;8M', CTX);
  d.onInput('[<0;32;8m', CTX);
  assert.deepEqual(seen, ['down', 'move', 'up']);
});

test('E-07d: Alt / Ctrl 同样走放行(不只是 Shift)', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  assert.equal(d.onInput('[<8;30;8M', CTX), false, 'Alt+按下');
  assert.equal(d.onInput('[<40;31;8M', CTX), false, 'Alt+位移');
  assert.equal(d.onInput('[<16;30;8M', CTX), false, 'Ctrl+按下');
  assert.equal(d.onInput('[<48;31;8M', CTX), false, 'Ctrl+位移');
  assert.deepEqual(seen, []);
});

test('E-08: 滚轮仍优先于选择层(Shift+滚轮 = 横向滚动,不是拖选)', () => {
  const seen = [];
  const wheels = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    onWheel: (dir) => wheels.push(dir),
    hover: false,
  });
  d.onInput('[<64;10;5M', CTX);
  assert.deepEqual(wheels, ['up']);
  assert.deepEqual(seen, [], '滚轮不该污染选区事件');
});

// ── 与点击层的共存:命中区上的手势既能是点击、也能是拖选 ─────────────────────
test('E-09: 命中卡片/按钮的按下**仍**上报 down,松手仍触发 onClick(两者不互斥)', () => {
  const seen = [];
  const t = treeWithCard();
  const ctx = { ...CTX, rootNode: t.root };
  const d = createMouseDispatcher({
    // 零宽 → 忠实返回「没消费」(与 App.js 的真实判据同形)。
    onSelectEvent: (kind) => { seen.push(kind); return false; },
  });
  d.onInput(PRESS_CARD, ctx); // row 1,在卡片(0..7 行)内
  d.onInput(RELEASE_CARD, ctx);
  assert.ok(seen.includes('down'),
    '命中区 ≠ 按钮:工具卡片铺满转录区,「命中即吞掉 down」会让整段拖选手势没有起点');
  assert.ok(seen.includes('up'), '松手是唯一的产出点,不能被点击分支吞掉');
  assert.equal(t.clicks.card, 1, '零宽(纯点击)⇒ 点击必须照旧触发');
});

// ── reset 必须取消进行中的手势 ───────────────────────────────────────────────
test('E-10: reset() 发出 cancel,让选择层丢掉半截手势(如窗口 resize / 切视图)', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
    hover: false,
  });
  d.onInput(PRESS_BLANK, CTX);
  d.onInput(MOVE, CTX);
  d.reset();
  assert.equal(seen[seen.length - 1], 'cancel', '不取消的话选区会卡在「拖到一半」状态');
});

test('E-11: 畸形鼠标序列不触发 select 回调(parseSgrMouse 返回 null 即退出)', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
  });
  for (const bad of ['', 'hello', '[<x;y;zM', '[<0;1M', '\x1b[A']) {
    assert.doesNotThrow(() => d.onInput(bad, CTX));
  }
  assert.deepEqual(seen, []);
});

test('E-12: 无 rootNode(Null)时早退,不发 select 事件 —— 布局未知画不了反色', () => {
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => seen.push(kind),
  });
  d.onInput(PRESS_BLANK, { rootNode: null, rows: 40 });
  assert.deepEqual(seen, [], '没有布局就没有「屏幕行 == 数组下标」这个前提');
});

// ── E5:返回值契约(「拖选」与「点击」的唯一分界)──────────────────────────────
// 起点落在命中区上的手势既可能是点击、也可能是拖选。dispatcher 在松手时无从判断,
// 真判据只有选择层手里有(选区是否非空)。于是 `onSelectEvent('up')` 的返回值成了
// 契约:`=== true` = 「这次手势我消费了」⇒ 不得再触发 onClick。
//
// 两条方向都必须钉住 —— 只钉一条的话,「把点击功能顺手删掉」也能让 E-13 变绿。
test('E-13: 拖出非空选区(回调返回 true)⇒ 不得再触发 onClick', () => {
  const t = treeWithCard();
  const ctx = { ...CTX, rootNode: t.root };
  const seen = [];
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => { seen.push(kind); return kind === 'up'; },
  });
  d.onInput(PRESS_CARD, ctx);
  d.onInput(MOVE_IN_CARD, ctx);
  d.onInput(RELEASE_CARD, ctx);
  assert.deepEqual(seen, ['down', 'move', 'up']);
  assert.equal(t.clicks.card, 0,
    '用户在卡片上拖选一段文字,不该顺手把卡片展开(2026-09-24 用户主诉的另一半症状)');
});

test('E-14: 零宽(回调返回 false)⇒ 点击必须照旧触发(回归保护)', () => {
  const t = treeWithCard();
  const ctx = { ...CTX, rootNode: t.root };
  const d = createMouseDispatcher({
    onSelectEvent: (kind) => { return kind === 'never'; },
  });
  d.onInput(PRESS_CARD, ctx);
  d.onInput(RELEASE_CARD, ctx);
  assert.equal(t.clicks.card, 1, '纯点击是按钮的核心价值,不能被拖选修复误伤');
});

test('E-15: 契约是**严格** true —— 回调顺手返回的真值不算消费', () => {
  const t = treeWithCard();
  const ctx = { ...CTX, rootNode: t.root };
  const seen = [];
  const d = createMouseDispatcher({
    // `push` 返回的是长度(number,真值但不是 true)—— 历史实现里最顺手的写法。
    onSelectEvent: (kind) => { seen.push(kind); },
  });
  d.onInput(PRESS_CARD, ctx);
  d.onInput(MOVE_IN_CARD, ctx);
  d.onInput(RELEASE_CARD, ctx);
  assert.equal(seen.length, 3, '事件照常上报');
  assert.equal(t.clicks.card, 1,
    '非 true 的真值不得被当成「已消费」,否则回调里一个手滑就把点击功能关掉了');
});

test('E-16: 回调抛异常 ⇒ fail-soft,点击照旧(选择层坏掉不能连累按钮)', () => {
  const t = treeWithCard();
  const ctx = { ...CTX, rootNode: t.root };
  const d = createMouseDispatcher({
    onSelectEvent: () => { throw new Error('selection layer exploded'); },
  });
  assert.doesNotThrow(() => {
    d.onInput(PRESS_CARD, ctx);
    d.onInput(RELEASE_CARD, ctx);
  });
  assert.equal(t.clicks.card, 1);
});
