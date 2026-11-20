// editorSearchBudget.test.mjs — 全局搜索的四件套上限与协作式收尾（DESIGN-ARCH-210 §4）。
// 断言的是「搜不完要说搜不完」：命中/文件/超大文件触顶必须 truncated + reason 带「还有 N 个
// 文件未扫描」，不许把截断说成没找到；取消走标志位，不 kill 任何东西。
//
// Run: node --experimental-strip-types --test tests/editorSearchBudget.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { runEditorSearch, cancelEditorSearch } = await import('../src/main/editor/search.ts')
const C = await import('../src/shared/editorContract.ts')

function makeRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-editor-search-${name}-`))
}

function write(root, rel, content) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

const noProgress = { onProgress: () => {} }

test('命中行号/列号 1-based，preview 取自命中行', async () => {
  const root = makeRoot('basic')
  const abs = write(root, 'a.ts', 'const x = 1\n  const needle = 2\n')
  const res = await runEditorSearch(root, 'needle', {}, noProgress)
  assert.equal(res.ok, true)
  assert.equal(res.hits.length, 1)
  assert.equal(res.hits[0].filePath, abs)
  assert.equal(res.hits[0].line, 2)
  assert.equal(res.hits[0].column, 9)
  assert.match(res.hits[0].preview, /needle = 2/)
  assert.equal(res.truncated, false)
})

test('默认不区分大小写，caseSensitive 时区分', async () => {
  const root = makeRoot('case')
  write(root, 'a.md', 'Needle needle NEEDLE\n')
  const loose = await runEditorSearch(root, 'needle', {}, noProgress)
  assert.equal(loose.hits.length, 3)
  const strict = await runEditorSearch(root, 'needle', { caseSensitive: true }, noProgress)
  assert.equal(strict.hits.length, 1)
})

test('单文件命中数封顶 SEARCH_MAX_HITS_PER_FILE', async () => {
  const root = makeRoot('perfile')
  const lines = Array.from({ length: C.SEARCH_MAX_HITS_PER_FILE + 10 }, (_, i) => `hit ${i}`)
  write(root, 'big.txt', lines.join('\n'))
  const res = await runEditorSearch(root, 'hit', {}, noProgress)
  assert.equal(res.hits.length, C.SEARCH_MAX_HITS_PER_FILE)
})

test('总命中数触顶：truncated + reason 写明还有多少文件未扫描', async () => {
  const root = makeRoot('hits')
  // 每个文件 20 处命中（单文件上限），26 个文件足够越过 500 处总上限
  const body = Array.from({ length: C.SEARCH_MAX_HITS_PER_FILE }, (_, i) => `needle ${i}`).join('\n')
  const files = Math.ceil(C.SEARCH_MAX_HITS / C.SEARCH_MAX_HITS_PER_FILE) + 1
  for (let i = 0; i < files; i += 1) write(root, `f${String(i).padStart(3, '0')}.txt`, body)
  const res = await runEditorSearch(root, 'needle', {}, noProgress)
  assert.equal(res.hits.length, C.SEARCH_MAX_HITS)
  assert.equal(res.truncated, true)
  assert.match(res.reason, /处上限/)
  assert.match(res.reason, /还有 \d+ 个文件未扫描/)
  assert.ok(res.scannedFiles < res.totalFiles, '触顶时不得声称扫完了')
})

test('超大文件与二进制文件被跳过并计入 skippedFiles', async () => {
  const root = makeRoot('skip')
  write(root, 'ok.txt', 'needle\n')
  write(root, 'huge.txt', 'x'.repeat(C.SEARCH_MAX_FILE_BYTES + 1) + 'needle')
  fs.writeFileSync(path.join(root, 'bin.txt'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]))
  const res = await runEditorSearch(root, 'needle', {}, noProgress)
  assert.equal(res.hits.length, 1)
  assert.equal(res.skippedFiles, 2)
  assert.equal(res.truncated, false, '跳过个别文件不等于整次搜索被截断')
})

test('忽略目录与非文本扩展名不进索引', async () => {
  const root = makeRoot('ignore')
  write(root, 'src/keep.ts', 'needle\n')
  write(root, 'node_modules/pkg/index.js', 'needle\n')
  write(root, '.hidden/secret.ts', 'needle\n')
  write(root, 'blob.bin', 'needle\n')
  const res = await runEditorSearch(root, 'needle', {}, noProgress)
  assert.equal(res.hits.length, 1)
  assert.match(res.hits[0].filePath, /src[\\/]keep\.ts$/)
})

test('空查询给出可执行错误文案', async () => {
  const root = makeRoot('empty')
  const res = await runEditorSearch(root, '   ', {}, noProgress)
  assert.equal(res.ok, false)
  assert.match(res.error, /搜索内容为空/)
})

test('取消走标志位：已取消的搜索不返回半份结果当成功', async () => {
  const root = makeRoot('cancel')
  for (let i = 0; i < 5; i += 1) write(root, `f${i}.txt`, 'needle\n')
  const pending = runEditorSearch(root, 'needle', { searchId: 'cancel_probe' }, noProgress)
  assert.equal(cancelEditorSearch('cancel_probe'), true)
  const res = await pending
  assert.equal(res.cancelled, true)
  assert.equal(res.truncated, true)
  assert.match(res.reason, /取消/)
  assert.equal(cancelEditorSearch('cancel_probe'), false, '同一 searchId 不得重复取消')
})

test('进度回调至少在上限两端各上报一次', async () => {
  const root = makeRoot('progress')
  write(root, 'a.txt', 'needle\n')
  const seen = []
  const res = await runEditorSearch(root, 'needle', { searchId: 'progress_probe' }, {
    onProgress: (p) => seen.push(p),
  })
  assert.equal(res.searchId, 'progress_probe')
  assert.ok(seen.length >= 2)
  assert.equal(seen[0].scannedFiles, 0)
  assert.equal(seen[seen.length - 1].scannedFiles, res.scannedFiles)
  assert.ok(seen.every((p) => p.searchId === 'progress_probe'))
})

test('非法 searchId 不被直接采信（防任意串灌进地图键）', async () => {
  const root = makeRoot('badid')
  write(root, 'a.txt', 'needle\n')
  const res = await runEditorSearch(root, 'needle', { searchId: 'has space/../x' }, noProgress)
  assert.notEqual(res.searchId, 'has space/../x')
  assert.match(res.searchId, /^editor_search_/)
})
