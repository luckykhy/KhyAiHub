'use strict';

// goldenFrames.test — 金帧 ANSI 快照回归（[MGMT-RPT-031] P1-4）。
//
// 对标 ink `test/helpers/reconstruct-terminal.ts` 的「对渲染出的 ANSI 做快照
// + diff」范式，但不引 PTY：被测对象是 scrollbackPreserve 四层变换（纯文本
// 进出、确定性），字节级金帧即可。金帧文件存「转义可见形」（`\x1b` 四字面），
// 可 diff、不受编辑器吞控制字节影响。
//
// 更新流程：`KHY_GOLDEN_UPDATE=1 node --test <本文件>` 重建基线 → 人工看 diff
// → 提交。「跑了就过、不看不提」的金帧等于没有金帧。
//
// 用 node:test（tests/ 树的全量 glob 约定）。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const golden = require(path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'goldenFrames'));
const sp = require(path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'scrollbackPreserve'));

const GOLDEN_DIR = path.join(__dirname, 'goldens');
const ESC = String.fromCharCode(27);

// ── 被测语料（与 scrollbackPreserve 头注释的实测场景一一对应）────────────────

// ink 6.8 ansi-escapes@7 现代形式（Win11 实测）：2J + 3J + H
const NIX_FRAME = `${ESC}[2J${ESC}[3J${ESC}[H` + 'static-banner\n' + 'frame-body\n';
// 老 conhost 形式：2J + 0f
const WIN_FRAME = `${ESC}[2J${ESC}[0f` + 'static-banner\n' + 'frame-body\n';
// 第三层冗余重发帧（clear + fullStaticOutput + output，与快照逐字节一致）
const REPRINT_SNAPSHOT = 'committed-line-1\ncommitted-line-2\n';
const REPRINT_FRAME = `${ESC}[2J${ESC}[3J${ESC}[H` + REPRINT_SNAPSHOT + 'live-tail\n';

function normalizer(env, platform, options) {
  return sp.createClearTerminalNormalizer(env || {}, platform || 'linux', options || null);
}

test('金帧基建自检：escapeVisible / fromVisible 往返一致', () => {
  assert.equal(golden.fromVisible(golden.escapeVisible(NIX_FRAME)), NIX_FRAME);
});

test('金帧基建自检：diffFrames 标出差异行', () => {
  const d = golden.diffFrames('a\nb\nc', 'a\nX\nc');
  assert.equal(d.equal, false);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].no, 2);
  assert.equal(d.lines[0].expected, 'X');
  assert.equal(d.lines[0].actual, 'b');
});

test('金帧：linux 现代帧只剥 3J（字节级）', () => {
  const n = normalizer({}, 'linux');
  const out = n.write(NIX_FRAME);
  const m = golden.matchGolden({
    name: 'linux-modern-strip-3j',
    actualRaw: out,
    dir: GOLDEN_DIR,
  });
  assert.ok(m.ok, m.reason || golden.diffFrames(golden.escapeVisible(out), fs.readFileSync(m.file, 'utf8')).lines.map((l) => `L${l.no} exp=${l.expected} act=${l.actual}`).join('\n'));
});

test('金帧：win32 现代帧改写为就地擦除 H+J（字节级）', () => {
  const n = normalizer({}, 'win32');
  const out = n.write(WIN_FRAME.replace(`${ESC}[0f`, `${ESC}[3J${ESC}[H`));
  const m = golden.matchGolden({ name: 'win32-modern-rewrite-hj', actualRaw: out, dir: GOLDEN_DIR });
  assert.ok(m.ok, m.reason || `diff at ${m.file}`);
});

test('金帧：win32 老 conhost 帧 2J+0f 改写为 H+J（字节级）', () => {
  const n = normalizer({}, 'win32');
  const out = n.write(WIN_FRAME);
  const m = golden.matchGolden({ name: 'win32-old-conhost-rewrite', actualRaw: out, dir: GOLDEN_DIR });
  assert.ok(m.ok, m.reason || `diff at ${m.file}`);
});

test('金帧：第三层冗余重发被剥离，只留 clear+output（字节级）', () => {
  const n = normalizer({}, 'linux', { getStaticSnapshot: () => REPRINT_SNAPSHOT });
  const out = n.write(REPRINT_FRAME);
  const m = golden.matchGolden({ name: 'reprint-suppressed-keep-tail', actualRaw: out, dir: GOLDEN_DIR });
  assert.ok(m.ok, m.reason || `diff at ${m.file}`);
});

test('金帧：第四层尾切 rows=5 时帧尾收敛到 4 行（字节级）', () => {
  // output 高度 > rows-1 → 前排滚出；尾切保证整帧不滚屏（零副本）。
  const output = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n') + '\n';
  const frame = `${ESC}[2J${ESC}[3J${ESC}[H` + output;
  const n = normalizer({}, 'linux', { getStaticSnapshot: () => '', getRows: () => 5 });
  const out = n.write(frame);
  const m = golden.matchGolden({ name: 'tailcut-rows5', actualRaw: out, dir: GOLDEN_DIR });
  assert.ok(m.ok, m.reason || `diff at ${m.file}`);
});

test('金帧：跨 write 拆开的帧暂存后拼装完整再归一化（字节级）', () => {
  const n = normalizer({}, 'linux');
  const half = Math.floor(NIX_FRAME.length / 2);
  const out1 = n.write(NIX_FRAME.slice(0, half));
  const out2 = n.write(NIX_FRAME.slice(half));
  const m = golden.matchGolden({ name: 'split-write-assembly', actualRaw: out1 + out2, dir: GOLDEN_DIR });
  assert.ok(m.ok, m.reason || `diff at ${m.file}`);
});

test('门控关：逐字节回退（金帧 = 原输入）', () => {
  const envOff = { KHY_PRESERVE_SCROLLBACK: '0' };
  const n = normalizer(envOff, 'linux');
  const out = n.write(NIX_FRAME);
  const m = golden.matchGolden({ name: 'gate-off-passthrough', actualRaw: out, dir: GOLDEN_DIR });
  assert.ok(m.ok, m.reason || `diff at ${m.file}`);
});
