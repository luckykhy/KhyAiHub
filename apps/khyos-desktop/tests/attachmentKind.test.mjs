// attachmentKind.test.mjs — 附件格式分桶（输入区 chip / @ 上下文列表 / 文件对话框共用）。
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/attachmentKind.test.mjs
//
// 用户诉求（2026-11-01）：「输入框里按我加的**文件格式**给一个简单渲染，pdf / mp4 /
// docx / txt / png / jpg 等等要设计不同的图标」。所以这里锁两件事：
//   ① 格式认得出来 —— 每个桶的代表扩展名落到对的桶，未知格式不瞎猜；
//   ② 桶一定画得出来 —— 桶 → 字形在全局 Icon 注册表里真实存在（不是写了名字没实现）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ATTACHMENT_ICON,
  EXT_KINDS,
  attachmentKind,
  attachmentTint,
  extensionsOf,
} from '../src/renderer/components/composer/attachmentKind.ts'

const iconSrc = readFileSync(
  join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ui', 'Icon.tsx'),
  'utf-8'
)

// ── ① 格式认得出来 ──────────────────────────────────────────────────

test('K1: 用户点名的格式各归其桶', () => {
  const cases = [
    ['report.pdf', 'pdf'],
    ['demo.mp4', 'video'],
    ['合同.docx', 'doc'],
    ['notes.txt', 'text'],
    ['README.md', 'md'],
    ['screenshot.png', 'image'],
    ['photo.jpg', 'image'],
    ['budget.xlsx', 'sheet'],
    ['pitch.pptx', 'slide'],
    ['voice.mp3', 'audio'],
    ['src.zip', 'archive'],
    ['Composer.tsx', 'code'],
  ]
  for (const [name, kind] of cases) {
    assert.equal(attachmentKind(name), kind, `${name} 应归到 ${kind}`)
  }
})

test('K1b: md 与 txt 分属两桶（同是纯文本，但不是同一种东西）', () => {
  assert.equal(attachmentKind('README.md'), 'md')
  assert.equal(attachmentKind('notes.txt'), 'text')
  assert.notEqual(ATTACHMENT_ICON.md, ATTACHMENT_ICON.text, 'md 与 txt 不能共用字形')
})

test('K2: 扩展名大小写不敏感', () => {
  assert.equal(attachmentKind('REPORT.PDF'), 'pdf')
  assert.equal(attachmentKind('Clip.MP4'), 'video')
  assert.equal(attachmentKind('Doc.DOCX'), 'doc')
})

test('K3: 无扩展名时用 MIME 兜底（剪贴板内容常只有 MIME）', () => {
  assert.equal(attachmentKind('粘贴图片', 'image/png'), 'image')
  assert.equal(attachmentKind('粘贴文件', 'video/quicktime'), 'video')
  assert.equal(attachmentKind('粘贴文件', 'application/pdf'), 'pdf')
  assert.equal(attachmentKind('粘贴文件', 'text/plain'), 'text')
})

test('K4: 认不出来就落到 file，不瞎猜', () => {
  assert.equal(attachmentKind('firmware.bin'), 'file')
  assert.equal(attachmentKind('.gitignore'), 'file', '隐藏文件没有扩展名，不应被当成 gitignore 格式')
  assert.equal(attachmentKind('README'), 'file')
  assert.equal(attachmentKind('', ''), 'file')
})

test('K5: 同一个扩展名只归一桶（表里不许重复登记）', () => {
  const seen = new Map()
  for (const [kind, exts] of EXT_KINDS) {
    for (const ext of exts) {
      assert.equal(seen.has(ext), false, `扩展名 ${ext} 同时登记在 ${seen.get(ext)} 与 ${kind}`)
      seen.set(ext, kind)
    }
  }
})

// ── ② 桶一定画得出来 ────────────────────────────────────────────────

test('K6: 每个桶都有字形，且字形在 Icon 注册表里真实存在', () => {
  for (const [kind] of EXT_KINDS.concat([['file', []]])) {
    const icon = ATTACHMENT_ICON[kind]
    assert.ok(icon, `${kind} 桶缺字形映射`)
    assert.match(
      iconSrc,
      new RegExp(`'${icon}'`),
      `Icon 注册表没有 '${icon}' 字形 —— ${kind} 桶会画成空白`
    )
  }
})

test('K7: 不同格式给不同字形（pdf / word / text 不共形）', () => {
  const icons = ['pdf', 'doc', 'md', 'text', 'code', 'image', 'video', 'audio', 'sheet', 'slide', 'archive']
    .map((kind) => ATTACHMENT_ICON[kind])
  assert.equal(new Set(icons).size, icons.length, `这些桶存在共用字形：${icons.join(', ')}`)
})

test('K8: 颜色只给惯用色的四个桶，其余走 muted（不铺满输入区）', () => {
  assert.equal(attachmentTint('pdf'), 'text-destructive')
  assert.equal(attachmentTint('sheet'), 'text-success')
  assert.equal(attachmentTint('slide'), 'text-warning')
  assert.equal(attachmentTint('image'), 'text-brand')
  assert.equal(attachmentTint('md'), 'text-brand')
  for (const kind of ['doc', 'text', 'code', 'video', 'audio', 'archive', 'file']) {
    assert.equal(attachmentTint(kind), 'text-foreground-muted', `${kind} 不该上彩色`)
  }
})

// ── ③ 文件对话框放行同一批格式 ───────────────────────────────────────

test('K9: 筛选器扩展名来自同一张表（pdf / mp4 都选得中）', () => {
  const docExts = extensionsOf('pdf', 'doc', 'sheet', 'slide')
  assert.ok(docExts.includes('pdf'), '文档组必须放行 pdf')
  assert.ok(docExts.includes('docx'), '文档组必须放行 docx')
  const mediaExts = extensionsOf('image', 'video', 'audio')
  assert.ok(mediaExts.includes('mp4'), '音视频组必须放行 mp4')
  assert.ok(mediaExts.includes('png'), '音视频组必须放行 png')
  assert.deepEqual(extensionsOf('pdf'), ['pdf'])
})
