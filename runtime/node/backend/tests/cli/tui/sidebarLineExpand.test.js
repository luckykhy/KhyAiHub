'use strict';

// 看板「带 … 的行可点击就地展开」—— 判据在纯叶子上，不渲染 ink。
//
// 这条能力有两个环节，缺任一都不成立，故两个都要钉：
//   ① buildSidebarLines 必须在**被裁掉**的行上留 `full`（未裁的行不许留，
//      否则每个字都能点，用户以为整块看板都是按钮）；
//   ② expandSidebarRows 必须把那一行**换成折好的多行**（只加标记不换行 =
//      点了没反应，而这正是本仓最常见的「看起来接上了、其实没生效」）。

const test = require('node:test');
const assert = require('node:assert');

const S = require('../../../src/cli/tui/ink-components/SidebarPanel');

const WIDTH = 30; // innerW = 28

function linesWith(props) {
  return S.buildSidebarLines({ width: WIDTH, taskLines: ['✓ 测试任务'], ...props });
}

test('通知行被裁 → 带 full；不裁 → 不带 full', () => {
  const long = linesWith({
    notifications: [{ level: 'info', title: '✓ khy 任务已完成', detail: '耗时 179 秒，输出见 .khy/feedback/xxx' }],
  });
  const longLine = long.find((l) => l.color === 'gray' && /khy 任务已完成/.test(l.text));
  assert.ok(longLine, '通知行必须渲染出来');
  assert.equal(typeof longLine.full, 'string', '被裁的通知行必须带全文');
  assert.ok(longLine.text.endsWith('…'), '折叠态必须以省略号收尾');
  assert.ok(longLine.full.length > longLine.text.length, '全文必须真的比显示文本长');

  const short = linesWith({ notifications: [{ level: 'info', title: '✓ 完成' }] });
  const shortLine = short.find((l) => /✓ 完成/.test(l.text));
  assert.equal(shortLine.full, undefined, '没被裁的行不许留 full（否则整块看板都变成按钮）');
});

test('cwd 行保尾截断 → 带完整路径', () => {
  const cwd = 'D:/Portable/khy-os/runtime/node/backend/src/cli/tui/ink-components';
  const lines = linesWith({ cwd, loadedToolsCount: 3 });
  const cwdLine = lines.find((l) => /ink-components/.test(l.text));
  assert.equal(cwdLine.full, cwd, '保尾截断丢的是头部，展开要能看回完整路径');
  assert.ok(cwdLine.text.startsWith('…'));
});

test('expandSidebarRows: 命中的那一行被换成折好的多行，且不再重复展开', () => {
  const full = '✓ khy 任务已完成 · 耗时 179 秒，输出见 .khy/feedback/tui-expand';
  const lines = [
    { text: '通知 1 条', bold: true },
    { text: '✓ khy 任务已完成 · 耗时 17…', color: 'gray', full },
    { text: '工具 179 个', dim: true },
  ];
  const out = S.expandSidebarRows(lines, full, 28);
  assert.ok(out.length > lines.length, '展开必须让行数变多');
  assert.equal(out[0].text, '通知 1 条', '前面的行不许动');
  assert.equal(out[out.length - 1].text, '工具 179 个', '后面的行不许动');
  const body = out.slice(1, -1);
  assert.ok(body.length > 1, '被裁的全文至少要折成两行');
  assert.ok(body.every((l) => l.expandedRow === true), '展开出来的行都要标 expandedRow');
  assert.equal(body.map((l) => l.text).join(''), full, '折行不许丢字');

  // 再跑一次（模拟下一帧）：已经展开的行不能再被展开一次，否则行数会指数膨胀。
  const again = S.expandSidebarRows(out, full, 28);
  assert.equal(again.length, out.length, '已展开的行必须被跳过');
});

test('expandSidebarRows: 没有命中 / 全文为空 / 列宽非法 → 原数组按引用返回', () => {
  const lines = [{ text: 'a', full: 'x' }];
  assert.strictEqual(S.expandSidebarRows(lines, 'nope', 28), lines);
  assert.strictEqual(S.expandSidebarRows(lines, '', 28), lines);
  assert.strictEqual(S.expandSidebarRows(lines, null, 28), lines);
  assert.strictEqual(S.expandSidebarRows(lines, 'x', 0), lines);
  assert.strictEqual(S.expandSidebarRows(null, 'x', 28).length, 0);
});
