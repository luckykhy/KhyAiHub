'use strict';

// viewportEmptyGrow — 空对话状态下主视口的横向撑满契约。
//
// 背景（为什么这个文件必须存在）：
//   树内任务看板（SidebarPanel，flexShrink:0）与左列视口共享 App 的 flex row。
//   非空分支的根 Box 本就带 flexGrow:1，看板贴住右缘；但**空对话分支**的根 Box
//   只有 height —— 左列缩成空态文字那几列宽，看板就贴着「暂无对话……」后面画，
//   浮在正文中间（2026-09-24 用户截图实证）。修复：新增可选 prop `grow`，
//   App 主视口传 true，空分支也带 flexGrow:1；其余调用方（PreviewLayout 列式
//   父容器）不传 → 逐字节保持旧布局。
//
//   `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const TUI_PATH = path.resolve(__dirname, '../../../../src/cli/tui');
const VP_PATH = path.join(TUI_PATH, 'ink-components/Viewport');

// ── 纯元素级契约（不起 yoga，直接调组件函数）────────────────────────────────
test('grow=true: 空对话分支根 Box 带 flexGrow:1（横向撑满 flex 行）', () => {
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  const Viewport = require(VP_PATH);
  return inkRuntime.loadInk().then(() => {
    const el = Viewport({ height: 3, lines: [], emptyText: '  x', grow: true });
    assert.equal(el.props.flexGrow, 1, '空分支必须带 flexGrow:1');
    assert.equal(el.props.height, 3);
    assert.equal(el.props.flexDirection, 'column');
  });
});

test('grow 缺省: 空对话分支不带 flexGrow（其余调用方逐字节不变）', () => {
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  const Viewport = require(VP_PATH);
  return inkRuntime.loadInk().then(() => {
    const el = Viewport({ height: 3, lines: [], emptyText: '  x' });
    assert.equal(el.props.flexGrow, undefined, '不传 grow 不得引入 flexGrow');
    const elFalse = Viewport({ height: 3, lines: [], emptyText: '  x', grow: false });
    assert.equal(elFalse.props.flexGrow, undefined);
  });
});

test('非空分支不受 grow 影响: 根 Box 恒带 flexGrow:1（既有行为回归 guard）', () => {
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  const Viewport = require(VP_PATH);
  return inkRuntime.loadInk().then(() => {
    const el = Viewport({ height: 3, lines: ['a', 'b'], grow: false });
    assert.equal(el.props.flexGrow, 1, '非空分支本就撑满，不得回退');
  });
});

// ── 布局对拍（真渲染：看板必须贴行右缘，而不是贴着空态文字）───────────────
function renderRow(grow) {
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  const ink = inkRuntime.get();
  const stripAnsi = require(path.resolve(__dirname, '../../../../src/utils/stripAnsi'));
  const Viewport = require(VP_PATH);
  const { Box, Text } = ink;
  const row = R.createElement(
    Box,
    { flexDirection: 'row', width: 60 },
    R.createElement(Viewport, {
      height: 2,
      lines: [],
      emptyText: '  x',
      ...(grow ? { grow: true } : {}),
    }),
    R.createElement(
      Box,
      { flexDirection: 'column', width: 10, flexShrink: 0 },
      R.createElement(Text, null, 'BOARD')
    )
  );
  const lines = stripAnsi(ink.renderToString(row, { columns: 60 })).split('\n');
  const hit = lines.find((l) => l.includes('BOARD'));
  assert.ok(hit, 'BOARD 必须出现在渲染输出里');
  return { col: hit.indexOf('BOARD'), line: hit };
}

test('布局: grow=true 时看板列贴行右缘（空态文字不再把看板顶到中间）', async () => {
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const { col } = renderRow(true);
  // 行宽 60、看板 10 列 → BOARD 起始列应为 50（0-based）。留 ±2 容差给渲染器。
  assert.ok(
    col >= 48,
    'grow=true 时 BOARD 应从 ~50 列起，实测列: ' + col
  );
});

test('布局: grow 缺省时保持旧布局（BOARD 紧贴空态文字，列 < 10）', async () => {
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const { col } = renderRow(false);
  assert.ok(col < 10, '无 grow 时 BOARD 应紧贴空态文字，实测列: ' + col);
});
