'use strict';

/**
 * attachmentChipWiring — 终端侧「按格式渲染附件」的接线守卫。
 *
 * 背景(2026-11-01 人提「除了桌面端的渲染还有终端怎么渲染」):桌面端与 web 已按 12 个桶
 * 出图标,终端两个面却只有计数 —— Ink TUI 输入框是 `已附加 N 张图片`,提交回显是 `×N`,
 * classic REPL 干脆只按「能不能当 utf-8 读成文本」分支,pdf/docx/xlsx/mp4 落空。
 *
 * Ink 组件脱离渲染环境跑不起来,故与 busySubmitUserEcho 同风格:用**源码接线断言**
 * 锁定「谁消费了哪个叶子」,再配合 attachmentFormat.test.js 的纯函数判据。
 *
 * 这些断言都写成**空白宽容**的:prettier 会重排,锁缩进等于制造假红。
 */

const fs = require('fs');
const path = require('path');

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
    toContain: (sub) => assert.ok(String(actual).includes(sub), `expected to contain: ${sub}`),
    notToContain: (sub) =>
      assert.ok(!String(actual).includes(sub), `expected NOT to contain: ${sub}`),
    toMatch: (re) => assert.match(String(actual), re),
    toBeTruthy: () => assert.ok(actual),
  });
}

const backendRoot = path.resolve(__dirname, '..', '..');
const read = (...seg) => fs.readFileSync(path.join(backendRoot, ...seg), 'utf8');

const chatColumn = read('src/cli/tui/ink-components/ChatColumn.js');
const transcript = read('src/cli/tui/ink-components/Transcript.js');
const transcriptLines = read('src/cli/tui/transcriptLines.js');
const chips = read('src/cli/tui/ink-components/AttachmentChips.js');
const appSrc = read('src/cli/tui/ink-components/App.js');
const bridgeSrc = read('src/cli/tui/hooks/useQueryBridge.js');
const replSrc = read('src/cli/replSession.js');
const pendingSrc = read('src/cli/tui/pendingImageAttachments.js');

_describe('Ink TUI 输入框:待发附件出 chip 行', () => {
  _test('ChatColumn 消费 AttachmentChips,不再只报数量', () => {
    _expect(chatColumn).toContain("require('./AttachmentChips')");
    _expect(chatColumn).toMatch(/h\(AttachmentChips,\s*\{\s*attachments:\s*pendingImageAttachments\.toDisplay\(pendingImages\)/);
    // 反向:旧的「只有计数」文案必须消失,否则 chip 与计数会同时出现
    _expect(chatColumn).notToContain('张图片`');
  });
});

_describe('Ink TUI 回显:提交后的用户消息带 chip', () => {
  _test('Transcript 两处用户分支共用 buildAttachmentEcho', () => {
    _expect(transcript).toContain('function buildAttachmentEcho(msg, h, Box, Text)');
    const calls = transcript.match(/buildAttachmentEcho\(msg, h, Box, Text\)/g) || [];
    // 1 处定义 + 2 处调用(白底框 / legacy 透明)
    _expect(calls.length).toBe(3);
  });

  _test('无 attachments 时退回 ×N(历史消息不丢计数)', () => {
    _expect(transcript).toMatch(/const count = Number\(msg\.imageCount\);/);
    _expect(transcript).toMatch(/count > 0 \? h\(Text, \{ color: 'blue' \}, `  ×\$\{count\}`\)/);
  });

  _test('transcriptLines 的纯文本投影同样出 chip,空则退回 ×N', () => {
    _expect(transcriptLines).toContain('function _attachmentChipsLine(msg)');
    _expect(transcriptLines).toMatch(/formatChipText\(att, \{ withSize: false \}\)/);
    _expect(transcriptLines).toMatch(/else if \(Number\(msg\.imageCount\) > 0\)/);
  });
});

_describe('提交契约:_attachments 是 UI-only,不进网关载荷', () => {
  _test('App 三处提交都带 _attachments', () => {
    const hits = appSrc.match(/_attachments:/g) || [];
    _expect(hits.length).toBe(3);
    // 暂存图(空文本发送 / 常规回合)与剪贴板兜底各取一次显示投影
    const displays = appSrc.match(/pendingImageAttachments\.toDisplay\(/g) || [];
    _expect(displays.length).toBe(3);
    _expect(appSrc).toMatch(/pendingImageAttachments\.toDisplay\(pendingImages\)\.concat\(inlineDisplay\)/);
    _expect(appSrc).toMatch(/pendingImageAttachments\.toDisplay\(assist\.images\)/);
  });

  _test('inline 路径图的显示描述与载荷分开构造', () => {
    _expect(appSrc).toMatch(/inlineDisplay = r\.display \|\| \[\]/);
    const inline = read('src/cli/tui/inlineImageSubmit.js');
    // images 仍是 base64 + mimeType(+ 多图 label),display 另起一条
    _expect(inline).toMatch(/images\.push\(\{\s*base64: image\.base64,\s*mimeType: image\.mimeType,\s*label: filePath,?\s*\}\)/);
    _expect(inline).toMatch(/display\.push\(\{/);
  });

  _test('回显只读 options._attachments,载荷仍走 options.images', () => {
    _expect(bridgeSrc).toMatch(/const attachments =\s*Array\.isArray\(options\._attachments\)/);
    _expect(bridgeSrc).toMatch(/const imageCount = Array\.isArray\(options\.images\)/);
    _expect(bridgeSrc).toMatch(/\{ role: 'user', content: text, imageCount, attachments, timestamp/);
  });

  _test('toPayload 只挑 base64 + mimeType(显示字段不外泄)', () => {
    _expect(pendingSrc).toMatch(/\.map\(\(\{ base64, mimeType \}\) => \(\{ base64, mimeType: mimeType \|\| 'image\/png' \}\)\)/);
  });
});

_describe('chip 形态:标签上色、不画按不动的叉', () => {
  _test('AttachmentChips 用 formatTag / formatTint,chip 只有「标签 + 名字」两段', () => {
    _expect(chips).toContain('attachmentFormat.formatTag(format)');
    _expect(chips).toContain('attachmentFormat.formatTint(format)');
    // 终端 chip 点不掉(删除仍是 Esc 清空 / 空输入退格删末张),画一个按不动的叉会骗人:
    // 因此渲染只允许 `[TAG]` 与 ` 名字` 两段文本。
    _expect(chips).toMatch(/`\[\$\{tag\}\]`/);
    _expect(chips).toMatch(/` \$\{name\}`/);
    _expect(chips).toContain('flexWrap');
  });

  _test('名字一律取 basename,不让完整路径铺进 chip', () => {
    _expect(chips).toContain('attachmentFormat.attachmentBasename');
  });
});

_describe('classic REPL:认得出格式的文件不再静默落空', () => {
  _test('replSession 引入终端侧格式真源并补上落空分支', () => {
    _expect(replSrc).toContain("require('./attachmentFormat')");
    _expect(replSrc).toMatch(/attachmentFormat\.attachmentFormat\(resolvedPath\) !== 'file'/);
    _expect(replSrc).toMatch(/attachmentFormat\.formatChipText\(\{/);
  });

  _test('新分支排在目录分支之后(不抢既有文本/压缩包分支)', () => {
    const dirIdx = replSrc.indexOf('已读取目录结构');
    const newIdx = replSrc.indexOf("attachmentFormat.attachmentFormat(resolvedPath) !== 'file'");
    const textIdx = replSrc.indexOf('已读取文件:');
    _expect(dirIdx > 0).toBe(true);
    _expect(textIdx > 0).toBe(true);
    // 目录分支在前、新分支紧随其后;文本分支必须更早(否则 pdf 会被当文本读)
    _expect(newIdx > dirIdx).toBe(true);
    _expect(textIdx < dirIdx).toBe(true);
  });
});
