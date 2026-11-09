// AmoonPane 的真实 DOM 测试：esbuild 打包 + jsdom 挂载，覆盖
// 「ok:false 仍要渲染四态」「空/空白输入禁用」「发送只在点击时发生」「queued 卡」
// 「cliFound=false 禁用启动」「回执 section 级未验证」。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')

const APP_DIR = path.resolve(__dirname, '..')

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khyamoon-ui-')), 'harness.cjs')
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'amooPanel.harness.tsx')],
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
]) {
  global[key] = dom.window[key]
}

const { mount, unmount, setStatus, setSend, setInbox, calls, runningStatus } = require(bundlePath)

const flush = async (times = 5) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
const text = () => document.getElementById('root').textContent || ''
const buttons = () => [...document.querySelectorAll('#root button')]
const byText = (re) => buttons().find((b) => re.test(b.textContent || ''))
const click = async (el) => {
  assert.ok(el, '找不到要点击的控件')
  el.click()
  await flush()
}
const type = async (value) => {
  const ta = document.querySelector('#root textarea')
  assert.ok(ta, '应渲染输入框')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, value)
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await flush()
}

test.after(() => {
  unmount()
  dom.window.close()
})

test.beforeEach(() => {
  unmount()
})

test('unhealthy（ok:false）仍渲染「不健康」、message/hint 与事实表，而不是「未运行」', async () => {
  calls.length = 0
  setStatus({
    ok: false,
    phase: 'unhealthy',
    message: 'runtime.json 存在但 /health 不通（端口 18765）',
    hint: 'daemon 可能已退出。先执行 node "D:\\repo\\bridge\\bin\\cli.js" stop 清理，再点「启动桥接」。',
    stateDir: 'C:\\state',
    stateDirExists: true,
    token: { present: true, valid: true, length: 47 },
    runtime: { present: true, pid: 4321, port: 18765, malformed: false },
    health: false,
    bridge: { root: 'D:\\repo\\bridge', cliFound: true },
    daemon: null,
    canSend: false,
    checkedAt: '2026-10-22T10:00:00.000Z',
    error: { code: 'health_unreachable', message: '127.0.0.1:18765/health 不可达' },
  })
  mount()
  await flush()
  assert.match(text(), /不健康/)
  assert.match(text(), /runtime\.json 存在但 \/health 不通（端口 18765）/)
  assert.match(text(), /cli\.js" stop/)
  assert.doesNotMatch(text(), /未运行/)
  assert.match(text(), /端口 18765/, '事实表应显示 runtime 端口')
  assert.ok(byText(/^停止$/), 'runtime 存在时应能停止/清理')
  assert.ok(byText(/^启动本机桥接$/), '非 running 时应能启动')
  const sendBtn = byText(/发送（投递，不等于送达）/)
  assert.equal(sendBtn.disabled, true, '不可发送时应禁用')
  assert.ok(!calls.some((c) => c[0] === 'send'), '不得自动发送')
})

test('running：空白输入禁用；只有点击发送才调用 amoonSend；结果带未验证', async () => {
  calls.length = 0
  setStatus(runningStatus())
  mount()
  await flush()
  assert.match(text(), /运行中/)
  const sendBtn = byText(/发送（投递，不等于送达）/)
  assert.equal(sendBtn.disabled, true, '空输入应禁用')

  await type('   ')
  assert.equal(sendBtn.disabled, true, '纯空白也应禁用')

  await type('你好 amoo')
  assert.equal(sendBtn.disabled, false)
  assert.ok(!calls.some((c) => c[0] === 'send'), '输入不触发发送')

  await click(sendBtn)
  const sent = calls.find((c) => c[0] === 'send')
  assert.deepEqual(sent, ['send', { text: '你好 amoo', openChat: false }])
  assert.match(text(), /已投递到手机 outbox/)
  assert.match(text(), /未验证/)
})

test('发送成功后约 1.2s 自动读取回执（send→inbox 引流：发送节经 onSent 通知面板）', async () => {
  calls.length = 0
  setStatus(runningStatus())
  mount()
  await flush()
  await type('引流测试')
  await click(byText(/发送（投递，不等于送达）/))
  assert.ok(!calls.some((c) => c[0] === 'inbox'), '成功回包刚落地时不应立刻读回执')
  await new Promise((r) => setTimeout(r, 1500))
  await flush()
  assert.ok(calls.some((c) => c[0] === 'inbox'), '1.2s 后应经面板触发一次回执读取')
})

test('queued 失败渲染「已排队（未投递）」并显示本地 spool 路径', async () => {
  calls.length = 0
  setStatus(runningStatus())
  setSend({
    ok: false,
    error: { code: 'adb_unavailable', message: '手机端 mv 失败（outbox 未写入）' },
    queued: { localPath: 'C:/tmp/spool/msg_q.json' },
  })
  mount()
  await flush()
  await type('排队测试')
  await click(byText(/发送（投递，不等于送达）/))
  assert.match(text(), /已排队（未投递）/)
  assert.match(text(), /C:\/tmp\/spool\/msg_q\.json/)
  assert.match(text(), /不会自动重试/)
})

test('cliFound=false：启动按钮禁用并提示设置环境变量', async () => {
  calls.length = 0
  setStatus({
    ok: true,
    phase: 'not_running',
    message: '桥接未运行（状态目录已存在，但没有 runtime.json）',
    hint: '点「启动桥接」启动本机 daemon。',
    stateDir: 'C:\\state',
    stateDirExists: true,
    token: { present: false, valid: false, length: 0 },
    runtime: { present: false, pid: null, port: null, malformed: false },
    health: false,
    bridge: { root: null, cliFound: false },
    daemon: null,
    canSend: false,
    checkedAt: '2026-10-22T10:00:00.000Z',
  })
  mount()
  await flush()
  const startBtn = byText(/^启动本机桥接$/)
  assert.equal(startBtn.disabled, true)
  assert.match(text(), /KHY_AMOON_BRIDGE_DIR/)
})

test('最近回执：section 级「未验证」，桥接未就绪时读取按钮禁用', async () => {
  calls.length = 0
  setStatus({
    ok: false,
    phase: 'not_running',
    message: '桥接未运行（状态目录已存在，但没有 runtime.json）',
    hint: '先启动',
    stateDir: 'C:\\state',
    stateDirExists: true,
    token: { present: false, valid: false, length: 0 },
    runtime: { present: false, pid: null, port: null, malformed: false },
    health: false,
    bridge: { root: 'D:\\bridge', cliFound: true },
    daemon: null,
    canSend: false,
    checkedAt: '2026-10-22T10:00:00.000Z',
  })
  mount()
  await flush()
  const readBtn = byText(/^读取$/)
  assert.equal(readBtn.disabled, true)
  assert.match(text(), /最近回执\s*未验证/)
})

test('running 时读取回执：调用 amoonInbox 并逐条标未验证', async () => {
  calls.length = 0
  setStatus(runningStatus())
  setInbox({
    ok: true,
    messages: [
      { id: 'ack_9', kind: 'ack', text: '好的', ts: '2026-10-22T10:01:00.000Z', status: 'received', unverified: true },
    ],
    count: 1,
    total: 1,
    skipped: 0,
    unverified: true,
  })
  mount()
  await flush()
  await click(byText(/^读取$/))
  assert.ok(calls.some((c) => c[0] === 'inbox'))
  assert.match(text(), /ack/)
  assert.match(text(), /好的/)
  assert.match(text(), /未验证/)
})
