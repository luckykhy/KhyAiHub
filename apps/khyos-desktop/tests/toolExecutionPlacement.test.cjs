// toolExecutionPlacement.test.cjs — 工具执行块「挂在对应提问下」的真实 DOM 验证。
//
// 用户报障：工具执行块显示在提问上方，并且切换会话后仍跟着显示。
// 本文件用 esbuild + jsdom 挂载真实的 MessageList + ToolExecutionPanel，钉住：
//   (a) 过程渲染在产生它的那条助手消息内部，不在消息列表上方；
//   (b) 用户提问在上、过程在下（阅读序）；
//   (c) 换会话后，上一个会话的过程不再出现（即使执行记录还在内存里）；
//   (d) 多轮提问各自带各自的过程，互不串台。
//
// 风格照 amooPanel.test.cjs：esbuild 打包 TSX，jsdom 挂真 DOM。

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')

const APP_DIR = path.resolve(__dirname, '..')
const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khytool-ui-')), 'harness.cjs')

esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'toolExecutionPlacement.harness.tsx')],
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

const { mount, unmount, store, setMessages, clearMessages, beginToolTurn, startToolExecution, clearExecutions } =
  require(bundlePath)

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
// 面板是 React.lazy 动态加载的：首例要等 chunk 解析完才渲染，固定 tick 数不够。
const waitFor = async (pred, label, timeout = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail(`${label}（等待 ${timeout}ms 未出现）`)
}
const text = () => document.getElementById('root').textContent || ''
// 面板头部的「工具执行 / 正在执行」按钮；用它反查所在的消息气泡。
const panelButtons = () =>
  [...document.querySelectorAll('#root button')].filter((b) => /^(工具执行|正在执行)/.test(b.textContent || ''))
const bubbleOf = (el) => el.closest('.group')

const userTurn = (id, content, ts) => ({ id, role: 'user', content, timestamp: ts, status: 'complete' })
const aiTurn = (id, content, ts) => ({ id, role: 'assistant', content, timestamp: ts, status: 'complete' })

function reset() {
  unmount()
  store.dispatch(clearMessages())
  store.dispatch(clearExecutions())
}

test.after(() => {
  unmount()
  dom.window.close()
})

test.beforeEach(reset)

test('过程渲染在对应回复内部：用户提问在上、工具执行在下，且不在列表顶部', async () => {
  store.dispatch(setMessages({
    sessionId: 's1',
    messages: [
      userTurn('u1', '今天有些什么新闻', 1),
      aiTurn('a1', '今天的主要新闻如下', 2),
    ],
  }))
  store.dispatch(beginToolTurn({ messageId: 'a1' }))
  store.dispatch(startToolExecution({ id: 'c1', name: 'webSearch', input: { q: 'news' }, requiresConfirmation: false }))
  mount()
  await flush()
  await waitFor(() => panelButtons().length === 1, '工具过程面板未渲染')

  assert.match(text(), /工具执行|正在执行/, '有执行时必须渲染过程块')
  assert.match(text(), /webSearch/)

  const panels = panelButtons()
  assert.equal(panels.length, 1, '只应有一块过程面板')
  const bubble = bubbleOf(panels[0])
  assert.ok(bubble, '过程块必须位于某条消息气泡内部')
  assert.match(bubble.textContent, /助手/, '过程块所属的是助手那一轮')
  assert.match(bubble.textContent, /今天的主要新闻如下/, '过程块与它产出的答复在同一条消息里')
  assert.doesNotMatch(bubble.textContent, /今天有些什么新闻/, '过程块不得渲染进用户提问的气泡')

  const whole = text()
  const panelIndex = Math.min(
    ...[whole.indexOf('工具执行'), whole.indexOf('正在执行')].filter((i) => i >= 0)
  )
  assert.ok(
    whole.indexOf('今天有些什么新闻') < panelIndex,
    '阅读序必须是：用户提问 → 工具执行 → 答复'
  )

  const root = document.getElementById('root')
  const firstBubble = root.querySelector('.group')
  assert.doesNotMatch(firstBubble.textContent, /工具执行|正在执行/, '过程块不得压在消息列表最上方（那正是原缺陷）')
})

test('换会话后不显示上一个会话的过程（即使执行记录尚未清空）', async () => {
  store.dispatch(setMessages({
    sessionId: 's1',
    messages: [userTurn('u1', '旧会话的提问', 1), aiTurn('a1', '旧会话的答复', 2)],
  }))
  store.dispatch(beginToolTurn({ messageId: 'a1' }))
  store.dispatch(startToolExecution({ id: 'c1', name: 'bash', input: { command: 'ls' }, requiresConfirmation: false }))
  mount()
  await flush()
  await waitFor(() => panelButtons().length === 1, '旧会话的过程面板未渲染')

  // 只换消息、故意不清 executions：归属过滤必须独立成立。
  store.dispatch(setMessages({
    sessionId: 's2',
    messages: [userTurn('h_s2_0', '新会话的提问', 3), aiTurn('h_s2_1', '新会话的答复', 4)],
  }))
  await flush()

  assert.equal(panelButtons().length, 0, '新会话不得继承上一个会话的工具过程')
  assert.doesNotMatch(text(), /旧会话的提问/, '消息区也已换成本会话')
})

test('多轮提问各自带各自的过程，不串台', async () => {
  store.dispatch(setMessages({
    sessionId: 's1',
    messages: [
      userTurn('u1', '第一问：今天新闻', 1),
      aiTurn('a1', '第一答', 2),
      userTurn('u2', '第二问：汇率', 3),
      aiTurn('a2', '第二答', 4),
    ],
  }))
  store.dispatch(beginToolTurn({ messageId: 'a1' }))
  store.dispatch(startToolExecution({ id: 'c1', name: 'webSearch', input: { q: 'news' }, requiresConfirmation: false }))
  store.dispatch(beginToolTurn({ messageId: 'a2' }))
  store.dispatch(startToolExecution({ id: 'c2', name: 'read_file', input: { path: 'rates.md' }, requiresConfirmation: false }))
  mount()
  await flush()
  await waitFor(() => panelButtons().length === 2, '两轮的过程面板未全部渲染')

  const panels = panelButtons()
  assert.equal(panels.length, 2, '两轮各有一块过程面板')

  const firstBubble = bubbleOf(panels[0])
  const secondBubble = bubbleOf(panels[1])
  assert.notEqual(firstBubble, secondBubble, '两块面板必须挂在不同的消息下')
  assert.match(firstBubble.textContent, /第一答/)
  assert.match(firstBubble.textContent, /webSearch/)
  assert.doesNotMatch(firstBubble.textContent, /read_file/, '第二轮的执行不得出现在第一轮下面')
  assert.match(secondBubble.textContent, /第二答/)
  assert.match(secondBubble.textContent, /read_file/)
})

test('没有工具执行的轮次不渲染空壳', async () => {
  store.dispatch(setMessages({
    sessionId: 's1',
    messages: [userTurn('u1', '纯问候', 1), aiTurn('a1', '你好', 2)],
  }))
  mount()
  await flush()

  assert.doesNotMatch(text(), /工具执行/)
  assert.doesNotMatch(text(), /正在执行/)
})
