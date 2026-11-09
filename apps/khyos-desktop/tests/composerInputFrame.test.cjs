'use strict';

// composerInputFrame.test.cjs — 桌面端 Composer 输入区的两条硬约定
// （2026-10-26 用户点名定，两轮）：
//
//   ① 单框、无内线 —— 输入区有且只有**一个框**，框里**没有分隔线**。
//      此前是「外框 + 内框 + 一条横线」（回字形），正文下方空出一块没用的地。
//   ② 粘贴附件 —— 剪贴板里的文件/图片能落盘成附件，chip 用全局 Icon 注册表的
//      SVG 字形按类型区分（图片 / 文档 / 代码 / 文件）。
//
// 断言走源码扫描（与 desktopUiContract 同款做法）：这两条都是「不许退回旧形态」的
// 约定，源码里对应的类名 / 接口一旦改回旧写法，测试即红。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const read = (...parts) => {
  const file = join(projectRoot, ...parts);
  return existsSync(file) ? readFileSync(file, 'utf-8') : '';
};

const composerSrc = read('src', 'renderer', 'components', 'composer', 'Composer.tsx');
const attachmentKindSrc = read('src', 'renderer', 'components', 'composer', 'attachmentKind.ts');
const listSrc = read('src', 'renderer', 'components', 'composer', 'AttachmentList.tsx');
const preloadSrc = read('src', 'preload', 'index.ts');
const mainSrc = read('src', 'main', 'index.ts');
const iconSrc = read('src', 'renderer', 'components', 'ui', 'Icon.tsx');

// ── ① 单框、无内线 ─────────────────────────────────────────────────

test('C1: textarea 不画分隔线（框内零线条）', () => {
  const block = composerSrc.match(/<textarea[\s\S]*?\/>/);
  assert.ok(block, 'Composer.tsx 里应能找到 textarea');
  assert.doesNotMatch(
    block[0],
    /border-b|border-t/,
    'textarea 不应再带 border-b/border-t —— 那条横线已按「不要单线」删除'
  );
});

test('C1: 工具栏行上方不再有分隔线（border-t border-border/50 已全量移除）', () => {
  assert.doesNotMatch(
    composerSrc,
    /border-t border-border\/50/,
    'Composer.tsx 不应再出现 border-t border-border/50 分隔线'
  );
});

test('C1: 内框只存在于 bottom 形态（不得两处并存成回字形）', () => {
  const hits = composerSrc.match(/rounded-xl border border-input-border/g) || [];
  assert.equal(
    hits.length,
    1,
    '带边框的输入容器只允许出现一次（bottom 形态）；card 形态的框就是卡片本身，出现两次即回字形'
  );
});

test('C1: card 形态的框是卡片本身（ring-1），且聚焦时描边变色', () => {
  assert.match(
    composerSrc,
    /ring-1 ring-card-border[^'"]*focus-within:ring-input-border-focused/,
    'card 形态的外框应带 ring-1，并在 focus-within 时变 --color-input-border-focused'
  );
});

test('C1: bottom 形态的输入容器聚焦时描边变色', () => {
  assert.match(
    composerSrc,
    /focus-within:border-input-border-focused/,
    'bottom 形态的输入容器应保留 focus-within 焦点提示'
  );
});

// ── ② 粘贴附件 + SVG 图标 ──────────────────────────────────────────

test('C2: textarea 挂了 onPaste 处理', () => {
  assert.match(composerSrc, /onPaste=\{handlePaste\}/, 'textarea 必须绑定 onPaste={handlePaste}');
});

test('C2: paste 只在剪贴板确实带文件时拦下默认粘贴', () => {
  const block = composerSrc.match(/const handlePaste = useCallback\([\s\S]*?\n  \}, \[addPastedFiles\]\)/);
  assert.ok(block, '应能找到 handlePaste 的实现');
  assert.match(block[0], /files\.length === 0\) return/, '纯文本粘贴必须放行（拦了就吞掉用户复制的内容）');
  assert.match(block[0], /preventDefault\(\)/, '带文件/图片的粘贴要拦下默认行为，改走附件');
});

test('C2: 粘贴内容经主进程落盘成真实路径', () => {
  assert.match(preloadSrc, /saveClipboardFile/, 'preload 必须暴露 saveClipboardFile');
  assert.match(mainSrc, /ipcMain\.handle\('fs:saveClipboardFile'/, 'main 必须注册 fs:saveClipboardFile');

  const handler = mainSrc.match(/ipcMain\.handle\('fs:saveClipboardFile'[\s\S]*?\n  \}\)/);
  assert.ok(handler, '应能找到 fs:saveClipboardFile 的处理函数');
  assert.match(handler[0], /os\.tmpdir\(\)/, '粘贴内容应落在系统临时目录（不是仓库里）');
  assert.match(handler[0], /writeFile/, 'fs:saveClipboardFile 必须真的写文件');
});

test('C2: 附件 chip 按类型取 SVG 图标，而不是写死 file', () => {
  // 映射表 2026-11-01 迁到 composer/attachmentKind.ts（与 @ 上下文列表、文件
  // 对话框共用一份真源），chip 渲染同轮迁进 composer/AttachmentList.tsx。
  // 断言随之改指向模块与组件，但守的是同一条约定：每个 kind 都必须有字形，
  // 且字形在 Icon 注册表里真实存在。
  const map = attachmentKindSrc.match(/export const ATTACHMENT_ICON[\s\S]*?\n\}/)
  assert.ok(map, 'attachmentKind.ts 里应能找到 ATTACHMENT_ICON 映射表');

  const entries = [...map[0].matchAll(/^\s{2}(\w+):\s*'([\w-]+)',?$/gm)]
  assert.ok(entries.length >= 10, `映射表应覆盖全部格式桶，实际 ${entries.length} 个`);

  for (const [, kind, icon] of entries) {
    assert.match(iconSrc, new RegExp(`'${icon}'`), `Icon 注册表应提供 '${icon}' 字形（${kind} 桶）`);
  }
  for (const kind of ['image', 'pdf', 'doc', 'sheet', 'slide', 'video', 'audio', 'archive', 'code', 'md', 'text', 'file']) {
    assert.ok(entries.some(([, k]) => k === kind), `映射表应覆盖 '${kind}' 桶`);
  }

  // chip 的图标出口是 AttachmentList（2026-11-01 从 Composer 内联块抽出来接线）
  assert.match(listSrc, /name=\{ATTACHMENT_ICON\[att\.kind\]\}/, 'chip 应按 kind 取图标');
  assert.match(listSrc, /attachmentTint\(att\.kind\)/, 'chip 图标色应走同一张色调表');
  assert.match(composerSrc, /<AttachmentList/, 'Composer 应渲染 AttachmentList');
});

test('C2: 附件大小由主进程 stat 带回（渲染层不碰文件系统）', () => {
  assert.match(mainSrc, /fs\.promises\.stat\(filePath\)/, 'main 侧 selectFiles 应 stat 文件大小');
  assert.match(mainSrc, /return \{ path: filePath, size \}/, 'selectFiles 应返回 { path, size }');
  assert.match(preloadSrc, /Promise<\{ path: string; size: number \}\[\]>/, 'preload 类型应带上 size');
  assert.match(listSrc, /formatFileSize\(att\.size\)/, 'AttachmentList 应显示文件大小');
});
