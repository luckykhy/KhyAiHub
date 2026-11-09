'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../src/cli/attachmentFormat');

test('12 个桶各有一批代表扩展名映射正确', () => {
  const cases = {
    'a.png': 'image',
    'a.pdf': 'pdf',
    'a.docx': 'doc',
    'a.xlsx': 'sheet',
    'a.pptx': 'slide',
    'a.mp4': 'video',
    'a.mp3': 'audio',
    'a.zip': 'archive',
    'a.js': 'code',
    'a.md': 'md',
    'a.txt': 'text',
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(fmt.attachmentFormat(name), expected, name);
  }
});

test('md 与 txt 分属不同桶且标签不同', () => {
  assert.equal(fmt.attachmentFormat('README.md'), 'md');
  assert.equal(fmt.attachmentFormat('notes.txt'), 'text');
  assert.notEqual(fmt.formatTag('md'), fmt.formatTag('text'));
});

test('扩展名大小写不敏感', () => {
  assert.equal(fmt.attachmentFormat('REPORT.PDF'), 'pdf');
  assert.equal(fmt.attachmentFormat('Clip.MP4'), 'video');
});

test('完整路径先取 basename，带点的目录名不误判', () => {
  assert.equal(fmt.attachmentFormat('C:\\Users\\a.b\\report.pdf'), 'pdf');
  assert.equal(fmt.attachmentFormat('/home/x/v1.2/notes.md'), 'md');
  // 目录名带点、文件本身没扩展名 → 落 file 而不是被判成点后那串
  assert.equal(fmt.attachmentFormat('C:\\Users\\a.b\\report'), 'file');
});

test('隐藏文件没有扩展名 → 交给 MIME，MIME 也没有则 file', () => {
  assert.equal(fmt.attachmentFormat('.gitignore'), 'file');
  assert.equal(fmt.attachmentFormat('.env', 'text/plain'), 'text');
});

test('没有扩展名时按 MIME 兜底', () => {
  assert.equal(fmt.attachmentFormat('clipboard', 'image/png'), 'image');
  assert.equal(fmt.attachmentFormat('clipboard', 'video/mp4'), 'video');
  assert.equal(fmt.attachmentFormat('clipboard', 'audio/wav'), 'audio');
  assert.equal(fmt.attachmentFormat('clipboard', 'application/pdf'), 'pdf');
  assert.equal(fmt.attachmentFormat('blob', 'text/plain'), 'text');
  assert.equal(fmt.attachmentFormat('blob', 'application/octet-stream'), 'file');
});

test('畸形输入 fail-soft，绝不抛', () => {
  assert.equal(fmt.attachmentFormat(), 'file');
  assert.equal(fmt.attachmentFormat(null), 'file');
  assert.equal(fmt.attachmentFormat(123), 'file');
  assert.equal(fmt.attachmentFormat('a.pdf', null), 'pdf');
});

test('扩展名表里没有重复注册（同一个后缀只能属于一个桶）', () => {
  const seen = new Map();
  for (const [format, exts] of fmt.EXT_FORMATS) {
    for (const ext of exts) {
      assert.equal(seen.has(ext), false, `${ext} 重复: ${seen.get(ext)} / ${format}`);
      seen.set(ext, format);
    }
  }
});

test('EXT_FORMATS 的桶都在 FORMATS 名册里，且每个桶都有标签', () => {
  for (const [format] of fmt.EXT_FORMATS) {
    assert.ok(fmt.FORMATS.includes(format), `${format} 不在 FORMATS`);
  }
  for (const format of fmt.FORMATS) {
    const tag = fmt.formatTag(format);
    assert.equal(typeof tag, 'string');
    assert.ok(tag.length >= 2 && tag.length <= 4, `${format} 标签宽度越界: ${tag}`);
  }
});

test('标签全桶唯一（不同桶不能共用一个标签）', () => {
  const tags = fmt.FORMATS.map((f) => fmt.formatTag(f));
  assert.equal(new Set(tags).size, tags.length, tags.join(','));
});

test('只有 image/pdf/sheet/slide/md 有惯用色，其余继承前景', () => {
  const tinted = fmt.FORMATS.filter((f) => fmt.formatTint(f));
  assert.deepEqual(tinted.sort(), ['image', 'md', 'pdf', 'sheet', 'slide']);
  for (const f of ['doc', 'video', 'audio', 'archive', 'code', 'text', 'file']) {
    assert.equal(fmt.formatTint(f), undefined, f);
  }
});

test('formatChipText 拼出 [标签] 名字 大小', () => {
  assert.equal(
    fmt.formatChipText({ name: '报告.pdf', size: 12595 }),
    '[PDF] 报告.pdf 12.3 KB'
  );
  assert.equal(fmt.formatChipText({ name: '说明.md' }), '[MD] 说明.md');
  assert.equal(fmt.formatChipText({ name: '说明.md', size: 0 }), '[MD] 说明.md');
  assert.equal(fmt.formatChipText({ name: 'a.pdf', size: 100 }, { withSize: false }), '[PDF] a.pdf');
});

test('formatChipText 对畸形输入 fail-soft', () => {
  assert.equal(fmt.formatChipText(null), '[FILE] 未命名');
  assert.equal(fmt.formatChipText({}), '[FILE] 未命名');
  assert.equal(fmt.formatChipText({ name: 'x.bin' }), '[FILE] x.bin');
});

test('formatChipText 走完整路径时只显示文件名', () => {
  assert.equal(fmt.formatChipText({ name: 'C:\\tmp\\a.pdf' }, { withSize: false }), '[PDF] a.pdf');
});
