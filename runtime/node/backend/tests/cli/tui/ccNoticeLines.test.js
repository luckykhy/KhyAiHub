'use strict';

/**
 * ccNoticeLines.test.js — 多行 notice 行模型的纯叶子断言（node:test）。
 *
 * 锁的是收集式命令输出（`khy phone status` / `khy amoo status` / `khy amoo send`）
 * 在 CC 会话里的**呈现不变量**：
 *   - 首行 `· `、续行两空格悬挂缩进 ⇒ 锯齿消失（第 2..N 行不再顶第 0 列）；
 *   - 段标题（`── … ──`）与记号行（`  ✓ ` / `  i ` / `  ⚠ `）被识别出来，
 *     正文里的同形字符不算（否则一段正常回复会被整段标成状态行）；
 *   - 行数上限截断带 `…（另有 N 行）`，且**不静默丢行**；
 *   - null / 非字符串 / 空串 / CRLF / 尾部空行全部归一，绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNoticeLines,
  classifyLine,
  clipNoticeLine,
  KINDS,
  NOTICE_MARKER,
  NOTICE_HANG,
} = require('../../../src/cli/tui/utils/ccNoticeLines');

const { displayWidth } = require('../../../src/cli/formatters');

test('clipNoticeLine：按显示宽度裁切，省略号用 `…` 而不是 ASCII `...`', () => {
  const clipped = clipNoticeLine('当前界面：节点 78 个，聊天列表未出现，聊天文本 0 字 / 0 行', 20);
  assert.ok(displayWidth(clipped) <= 20, `裁完应 ≤20，实为 ${displayWidth(clipped)}`);
  assert.ok(clipped.endsWith('…'), `应以 … 结尾，实为 ${JSON.stringify(clipped)}`);
  assert.ok(!clipped.endsWith('...'), '不许出现 ASCII 三点');
});

test('clipNoticeLine：装得下时原样返回，且内嵌换行被单行化', () => {
  assert.equal(clipNoticeLine('设备在线', 40), '设备在线');
  assert.equal(clipNoticeLine('a\r\nb', 40), 'a b');
  assert.equal(clipNoticeLine(null, 40), '');
});

test('clipNoticeLine：窄列下也不超宽（CJK 双宽感知）', () => {
  for (const w of [4, 6, 10, 17, 33]) {
    const clipped = clipNoticeLine('设备：192.168.2.46:33743 端口转发已建立', w);
    assert.ok(displayWidth(clipped) <= w, `宽度 ${w} 下超宽：${displayWidth(clipped)}`);
  }
});

test('首行记号 + 续行悬挂缩进', () => {
  const { lines } = buildNoticeLines('第一行\n第二行\n第三行');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].marker, NOTICE_MARKER);
  assert.equal(lines[0].text, '第一行');
  assert.equal(lines[1].marker, NOTICE_HANG);
  assert.equal(lines[1].text, '第二行');
  // 缩进宽度必须等于记号宽度，续行才对齐到首行正文之下。
  assert.equal(NOTICE_MARKER.length, NOTICE_HANG.length);
  for (const ln of lines) {
    assert.equal((ln.marker + ln.text).indexOf(ln.text), NOTICE_MARKER.length);
  }
});

test('单行 notice 只有首行记号', () => {
  const { lines } = buildNoticeLines('只有一行');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].marker, NOTICE_MARKER);
});

test('段标题被识别（renderStatusText / renderDispatchResultText 的形状）', () => {
  assert.equal(classifyLine('── Amoo 答复 ──'), KINDS.SECTION);
  assert.equal(classifyLine('  ── 执行计划 ──  '), KINDS.SECTION);
  const { lines } = buildNoticeLines('── 链路 ──\n设备在线');
  assert.equal(lines[0].kind, KINDS.SECTION);
  assert.equal(lines[1].kind, KINDS.PLAIN);
});

test('行首记号行被识别，正文里的同形字符不算', () => {
  // consoleNotice.js / consoleError.js 的真前缀都带尾随空格。
  assert.equal(classifyLine('  ✓ 手机桥接在线'), KINDS.MARK);
  assert.equal(classifyLine('  ✗ 调用失败'), KINDS.MARK);
  assert.equal(classifyLine('  ⚠ 令牌不可用'), KINDS.MARK);
  assert.equal(classifyLine('  i 设备：192.168.2.46:33743'), KINDS.MARK);
  // `i` 不带空格不算 —— 否则 "input 未找到" 会被误判成记号行。
  assert.equal(classifyLine('input 未找到'), KINDS.PLAIN);
  // 记号出现在行中也不算。
  assert.equal(classifyLine('设备 ✓ 在线'), KINDS.PLAIN);
});

test('maxLines 截断不静默丢行', () => {
  const { lines, total, truncated } = buildNoticeLines('a\nb\nc\nd\ne', { maxLines: 3 });
  assert.equal(total, 5);
  assert.equal(truncated, true);
  assert.equal(lines.length, 4); // 3 行 + 1 行提示
  assert.equal(lines[3].text, '…（另有 2 行）');
  assert.equal(lines[3].marker, NOTICE_HANG);
});

test('未超限时 truncated 为 false 且不加提示行', () => {
  const { lines, truncated } = buildNoticeLines('a\nb', { maxLines: 5 });
  assert.equal(truncated, false);
  assert.equal(lines.length, 2);
});

test('CRLF / 尾部空行 / 首行空行归一', () => {
  const { lines, total } = buildNoticeLines('\r\n第一行\r\n第二行\r\n\r\n');
  assert.equal(total, 3); // 首行空行保留（它是有意义的视觉分隔），尾部空行去掉
  assert.equal(lines[0].text, '');
  assert.equal(lines[1].text, '第一行');
  assert.equal(lines[2].text, '第二行');
});

test('输入容度：null / undefined / 空串 → 空行模型；标量归一成文本，绝不抛', () => {
  for (const bad of [null, undefined, '', '   ', '\n\n']) {
    const { lines, total, truncated } = buildNoticeLines(bad);
    assert.deepEqual(lines, [], `期望 ${JSON.stringify(bad)} 产生空行模型`);
    assert.equal(total, 0);
    assert.equal(truncated, false);
  }
  // 标量按 String() 归一：内容可能是垃圾，但绝不能不抛。
  for (const scalar of [42, true, {}, []]) {
    const { lines } = buildNoticeLines(scalar);
    assert.ok(Array.isArray(lines));
    for (const ln of lines) {
      assert.equal(typeof ln.text, 'string');
      assert.equal(ln.marker.length, NOTICE_MARKER.length);
    }
  }
  assert.equal(buildNoticeLines(42).lines[0].text, '42');
});

test('行 key 唯一且稳定（React.memo 按 key 比对）', () => {
  const { lines } = buildNoticeLines('a\nb\nc');
  const keys = lines.map((l) => l.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('khy phone status 的真实形状：多次 print 混成一条 notice', () => {
  const content = [
    '  ✓ 手机桥接在线',
    '  i 设备：192.168.2.46:33743',
    'HTTP 通道：http://127.0.0.1:8896',
    '信箱目录：/sdcard/bridge-amoobridge（仅兜底）',
  ].join('\n');
  const { lines } = buildNoticeLines(content);
  assert.equal(lines.length, 4);
  assert.equal(lines[0].kind, KINDS.MARK);
  assert.equal(lines[1].kind, KINDS.MARK);
  assert.equal(lines[2].kind, KINDS.PLAIN);
  assert.equal(lines[3].kind, KINDS.PLAIN);
  // 每一行的正文都从同一列开始（marker 宽度相同）。
  const starts = lines.map((l) => l.marker.length);
  assert.deepEqual(starts, [2, 2, 2, 2]);
});
