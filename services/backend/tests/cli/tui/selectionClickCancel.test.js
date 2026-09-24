'use strict';

/**
 * selectionClickCancel.test.js — 「纯点击 = 取消选区」契约(node:test)。
 *
 * 用户主诉(2026-09-24):拖选复制后,点空白区域取消不掉反色选区。
 *
 * 根因(探针实测,见 C-04):松手判零宽时,App 层曾把**零宽残迹**
 * `{anchor:{l,c}, head:{l,c}}` 原样存进 state。渲染侧:
 *   - 非空行 → mid='' → 无可见反色(所以以前没被察觉);
 *   - **空行** → Viewport.sliceLineForSelection 的 `len===0` 分支吐出
 *     `mid=' '` 且 `highlighted:true` → 一条**反色空行条**,点一次挪一次,
 *     永远清不掉 —— 正是用户看到的「取消不掉」。
 *
 * 修复契约:零宽手势(纯点击)在松手时必须存 `clearSelection()`
 * (`{anchor:null, head:null, dragging:false}`),而不是零宽残迹。
 * 修复落点:`ink-components/App.js` 与 `CcApp.js` 的 `up` 分支 ——
 * 两处都是 React 组件内联逻辑,无法直接单测,故本文件:
 *   ① 用 selection.js 叶子钉「纯点击 ⇒ normalizeSelection 为 null」这条判据;
 *   ② 用渲染叶子钉「清除态在任何行(含空行)都不反色」这条用户可见终态;
 *   ③ 用源码探针钉两处接线(回归时指向明确的改回去的那一行)。
 *
 * 运行:node --test tests/cli/tui/selectionClickCancel.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TUI = path.resolve(__dirname, '../../../src/cli/tui');
const sel = require(path.join(TUI, 'selection'));
const { sliceLineForSelection } = require(path.join(TUI, 'ink-components', 'Viewport'));

// ── ① 叶子判据:纯点击 ⇔ 零宽 ────────────────────────────────────────────────

test('C-01: 拖出非零宽区间 → normalize 非 null(复制路径不受本修复影响)', () => {
  let s = sel.beginSelection(sel.createSelection(), 3, 2);
  s = sel.extendSelection(s, 3, 7);
  s = sel.endSelection(s);
  assert.notEqual(sel.normalizeSelection(s), null, '真实拖选必须仍走复制/反色路径');
  assert.equal(sel.hasSelection(s), true);
});

test('C-02: 纯点击(按下与松手同点)→ 零宽 ⇒ 按契约必须存 clearSelection()', () => {
  let s = sel.beginSelection(sel.createSelection(), 5, 3);
  s = sel.extendSelection(s, 5, 3); // 无 move 的快速点击
  s = sel.endSelection(s);
  assert.equal(sel.normalizeSelection(s), null, '纯点击判不出非空区间');
  // App 层的契约:判零宽后存 cleared,而不是残迹 s 本身。
  const cleared = sel.clearSelection();
  assert.equal(sel.hasSelection(cleared), false);
  assert.equal(cleared.anchor, null, 'anchor 必须为 null —— 这是渲染侧「全灭」的判据');
  assert.equal(cleared.dragging, false);
  // 清除态与残迹必须可区分:hasSelection 对两者都是 false,但 anchor 形状不同。
  assert.notDeepStrictEqual(cleared, s, '清除态 ≠ 零宽残迹(残迹的 anchor 是点对象)');
});

// ── ② 渲染终态:清除态在任何行都不反色 ──────────────────────────────────────

const CLEARED = { anchor: null, head: null, dragging: false };

test('C-03: 清除态 → 空行/非空行/任意行都不反色(用户可见终态)', () => {
  for (const [line, idx] of [['', 5], ['hello world', 5], ['', 0], ['中文行', 2], ['', 999]]) {
    const seg = sliceLineForSelection(line, idx, CLEARED);
    assert.equal(seg.highlighted, false, `清除态不得反色: line=${JSON.stringify(line)} row=${idx}`);
    assert.equal(seg.mid, '');
  }
});

test('C-04: 根因存证 —— 零宽残迹落在空行上会画出反色条(修复前行为)', () => {
  const remnant = { anchor: { line: 5, col: 0 }, head: { line: 5, col: 0 }, dragging: false };
  const empty = sliceLineForSelection('', 5, remnant);
  assert.equal(empty.highlighted, true, '这就是「点空白取消不掉」的可见残迹');
  assert.equal(empty.mid, ' ');
  // 非空行上残迹不可见(mid='')—— 这正是它长期没被发现的理由。
  const text = sliceLineForSelection('hello world', 5, {
    anchor: { line: 5, col: 3 }, head: { line: 5, col: 3 }, dragging: false,
  });
  assert.equal(text.highlighted, true);
  assert.equal(text.mid, '');
});

// ── ③ 接线探针:两处 up 分支必须存 clearSelection ────────────────────────────

/** 取 `marker` 开始到其后第一个 `endMarker`(**含**)的源码片段。 */
function branchOf(src, marker, endMarker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `源码里找不到接线点: ${marker}`);
  const j = src.indexOf(endMarker, i);
  assert.ok(j > i, `接线点没有闭合: ${marker}`);
  return src.slice(i, j + endMarker.length);
}

test('C-05: Legacy App.js 零宽分支存的是 clearSelection(),不是残迹', () => {
  const src = fs.readFileSync(path.join(TUI, 'ink-components', 'App.js'), 'utf8');
  const branch = branchOf(src, 'if (!range) {', 'return false;');
  assert.ok(branch.includes('sel.clearSelection()'), '零宽分支必须存 clearSelection()');
  assert.ok(!branch.includes('setSelectRegion(finished)'), '不得再把零宽残迹存进 state');
  assert.ok(branch.includes('return false'), '仍须回答「没消费」让点击照旧触发');
});

test('C-06: CcApp.js 零宽分支存的是 clearSelection(),不是残迹', () => {
  const src = fs.readFileSync(path.join(TUI, 'ink-components', 'CcApp.js'), 'utf8');
  const branch = branchOf(
    src,
    'if (!_sel.normalizeSelection(finished)) {',
    'return false;'
  );
  assert.ok(branch.includes('_sel.clearSelection()'), '零宽分支必须存 clearSelection()');
  assert.ok(!branch.includes('setSelectRegion(finished)'), '不得再把零宽残迹存进 state');
});

test('C-07: cancel 路径(resize/切视图/任意键)与点击取消同一终态', () => {
  const cleared = sel.clearSelection();
  for (const [line, idx] of [['', 3], ['abc', 3]]) {
    const seg = sliceLineForSelection(line, idx, cleared);
    assert.equal(seg.highlighted, false);
  }
});
