'use strict'

// toolDiffView.test.cjs — 红绿 ±diff 视图的真实 DOM 契约。
//
// 用户报障：khyos 的改动只显示一段 JSON / 截断文本，没有红绿 +/- 视图。
// 本文件用 esbuild + jsdom 挂真实的 DiffViewer / DiffSummary，钉住：
//   (a) add/del 行分别落到绿色 +、红色 -，并带各自的 +N/-N；
//   (b) 行数超折叠阈值时如实说明「还有 N 行」，点开能看到全部；
//   (c) 传输被截断（truncated）时必须明说只显示了前 N 行，不假装完整；
//   (d) 汇总面板按文件显示真实行数，展开就能看该文件的红绿行；
//   (e) 没有 diff 的文件不显示「查看改动」，只留打开文件。
//
// 风格照 toolExecutionPlacement.test.cjs：esbuild 打包 TSX，jsdom 挂真 DOM。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')

const APP_DIR = path.resolve(__dirname, '..')
const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khydiff-ui-')), 'harness.cjs')

esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'diffViewer.harness.tsx')],
  outfile: bundlePath,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  absWorkingDir: APP_DIR,
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
})

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
for (const key of [
  'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent',
  'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser',
  'MutationObserver',
]) {
  global[key] = dom.window[key]
}

const { FIXTURE, mountViewer, mountSummary, unmount } = require(bundlePath)

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
const text = () => document.getElementById('root').textContent || ''
const rowsOfKind = (kind) => [...document.querySelectorAll(`#root [data-kind="${kind}"]`)]
const clickButton = (label) => {
  const btn = [...document.querySelectorAll('#root button')].find((b) => (b.textContent || '').includes(label))
  assert.ok(btn, `找不到按钮「${label}」`)
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

test.after(() => {
  unmount()
  dom.window.close()
})

test.beforeEach(() => unmount())

test('add/del 行分别上绿/红并带 +/-，上下文行不上色', async () => {
  mountViewer()
  await flush()

  assert.equal(rowsOfKind('add').length, 2, '两条新增行')
  assert.equal(rowsOfKind('del').length, 1, '一条删除行')
  assert.equal(rowsOfKind('ctx').length, 2, '上下文行不参与增删计数')

  assert.match(rowsOfKind('add')[0].className, /bg-success\/10/, '新增行必须有绿色底')
  assert.match(rowsOfKind('del')[0].className, /bg-destructive\/10/, '删除行必须有红色底')
  assert.doesNotMatch(rowsOfKind('ctx')[0].className, /bg-(success|destructive)/, '上下文行不得被染成红绿')

  assert.match(rowsOfKind('add')[0].textContent, /\+/, '新增行有 + 前缀')
  assert.match(rowsOfKind('del')[0].textContent, /-/, '删除行有 - 前缀')
  assert.match(text(), /arr\.length <= 1/, '新增行正文在')
  assert.match(text(), /arr\.length === 0/, '被删除的原文也在')

  assert.match(text(), /\+2/, '头部有新增行数')
  assert.match(text(), /-1/, '头部有删除行数')
  assert.match(text(), /quicksort\.ts/, '头部标明改的是哪个文件')
})

test('超过折叠阈值时说明还有多少行，点开后全部可见', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ kind: 'ctx', num: i + 1, text: `line ${i + 1}` }))
  mountViewer({ filePath: 'big.ts', added: 0, removed: 0, truncated: false, rows })
  await flush()

  assert.equal(rowsOfKind('ctx').length, 60, '首屏只铺折叠阈值内的行')
  assert.match(text(), /还有 20 行未显示/)

  clickButton('还有 20 行未显示')
  await flush()
  assert.equal(rowsOfKind('ctx').length, 80, '点开后必须能看到全部行')
  assert.doesNotMatch(text(), /还有 20 行未显示/)
})

test('传输被截断时如实说明只显示了前 N 行', async () => {
  mountViewer({ ...FIXTURE, truncated: true })
  await flush()
  assert.match(text(), /仅传输前 2000 行/, '截断必须说清，不许假装完整')
})

test('汇总面板：按文件显示真实 +N/-N，展开看该文件的红绿行', async () => {
  mountSummary([
    { path: 'src/sort/quicksort.ts', status: 'modified', additions: 2, deletions: 1, diff: FIXTURE },
    { path: 'README.md', status: 'modified', additions: 0, deletions: 0, diff: undefined },
  ])
  await flush()

  assert.match(text(), /本轮文件改动/, '汇总面板标题')
  assert.match(text(), /2 个文件/)
  assert.match(text(), /\+2/)
  assert.match(text(), /-1/)
  assert.doesNotMatch(text(), /arr\.length <= 1/, '未展开时先不铺行')

  // 展开前统计：只有带 diff 的那个文件有「查看改动」
  const viewButtons = [...document.querySelectorAll('#root button')].filter((b) => /查看改动/.test(b.textContent || ''))
  assert.equal(viewButtons.length, 1, '没有 diff 的文件不显示「查看改动」（那会点开一片空白）')

  clickButton('查看改动')
  await flush()
  assert.match(text(), /arr\.length <= 1/, '点开「查看改动」后必须能看到红绿行')
  assert.equal(rowsOfKind('add').length, 2)
  assert.match(text(), /打开文件/, '没有 diff 的文件仍可打开原文件')
})
