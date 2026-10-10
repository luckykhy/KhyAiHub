// 移动端远程控制面板的真实 DOM 测试。
//
// 为什么不用 npm run dev 实拍：out/ 是已跟踪的构建产物，且此刻正被一个运行中的
// KhyOS Desktop 实例加载（out/host/index.js / out/scheduler/index.js 都在跑），
// 重建它会动到别人正在用的文件。这里改用 esbuild 打包 + jsdom 挂载，把面板的
// 状态渲染与每一次点击真的跑一遍。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')

const APP_DIR = path.resolve(__dirname, '..')

const bundlePath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'khywr-ui-')),
  'harness.cjs',
)
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'webRemotePanel.harness.tsx')],
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
// Node 22 的 globalThis.navigator 是只读 getter，只能 defineProperty 覆盖。
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
for (const key of [
  'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMParser',
]) {
  global[key] = dom.window[key]
}
try {
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async () => {} },
    configurable: true,
  })
} catch {
  /* jsdom 版本差异：复制用例自己兜底 */
}

const { mount, emit, setStatus, calls } = require(bundlePath)

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
const text = () => document.getElementById('root').textContent
const buttons = () => [...document.querySelectorAll('#root button')]
const byText = (re) => buttons().find((b) => re.test(b.textContent || ''))
const click = async (el) => {
  assert.ok(el, '找不到要点击的控件')
  el.click()
  await flush()
}

test('初始渲染：未开启态 + 开启按钮 + 控制对象分段', async () => {
  mount()
  await flush()
  assert.match(text(), /未开启/)
  // 副标题由 SettingsPage 的页头承担，面板内不得重复一遍（真窗口实拍发现的冗余）
  assert.equal(
    (text().match(/扫码或在手机上打开链接/g) || []).length,
    0,
    '面板自身不应重复页头描述',
  )
  assert.ok(byText(/^开启$/), '应有开启按钮')
  assert.ok(byText(/桌面工作区/) && byText(/后端 CLI 会话/), '控制对象应可切换')
  assert.match(text(), /允许局域网设备控制/, '局域网开关应在（label 不是 button）')
  assert.ok(document.querySelector('#root input[type=checkbox]'), '开关应是可勾选的复选框')
})

test('点开启：走 remoteStart，二维码/链接/复制/刷新都出现', async () => {
  await click(byText(/^开启$/))
  assert.deepEqual(calls.at(-1), ['start', { lanEnabled: false }])
  assert.match(text(), /等待手机连接 · http:\/\/127\.0\.0\.1:9413\/r#p=ABCD1234/)
  const img = document.querySelector('#root img')
  assert.ok(img && /^data:image\/png/.test(img.getAttribute('src')), '应渲染二维码图片')
  assert.ok(byText(/复制链接/), '无法扫码时应有复制链接兜底')
  assert.ok(byText(/刷新二维码/), '应有刷新二维码')
})

test('局域网开关是显式的：勾选后 remoteStart 才带 lanEnabled=true', async () => {
  await click(byText(/^停止$/))
  const box = document.querySelector('#root input[type=checkbox]')
  box.click()
  await flush()
  await click(byText(/^开启$/))
  assert.deepEqual(calls.at(-1), ['start', { lanEnabled: true }])
})

test('待确认配对：同意（可发消息）以 operator 落到 remoteApprove', async () => {
  setStatus({
    pending: [{ pairingId: 'ABCD1234', deviceInfo: { name: 'Pixel-8' }, expiresAt: Date.now() + 60000 }],
  })
  emit({ kind: 'pairRequest', pairingId: 'ABCD1234' })
  await flush()
  assert.match(text(), /待确认的配对请求/)
  assert.match(text(), /Pixel-8 · 配对码 ABCD1234/)
  await click(byText(/同意（可发消息）/))
  assert.deepEqual(calls.at(-1), ['approve', 'ABCD1234', 'operator'])
  assert.ok(!/待确认的配对请求/.test(text()), '确认后待确认区应消失')
})

test('已配对设备可逐个撤销', async () => {
  setStatus({ devices: [{ deviceId: 'dev1', name: 'iPhone-12', role: 'viewer', lastSeenAt: Date.now() }] })
  emit({ kind: 'status' })
  await flush()
  assert.match(text(), /已配对设备/)
  assert.match(text(), /iPhone-12 · viewer/)
  await click(byText(/^撤销$/))
  assert.deepEqual(calls.at(-1), ['revoke', 'dev1'])
})

test('刷新二维码要先二次确认，确认后才真的刷新', async () => {
  setStatus({ pending: [], devices: [] })
  emit({ kind: 'status' })
  await flush()
  const before = calls.filter((c) => c[0] === 'refreshQr').length
  await click(byText(/^刷新二维码$/))
  assert.match(text(), /刷新二维码？/, '应弹确认而不是直接刷')
  assert.match(text(), /之前复制或扫码得到的远程控制链接将失效/)
  assert.equal(calls.filter((c) => c[0] === 'refreshQr').length, before, '确认前不得刷新')
  await click(byText(/^刷新$/))
  assert.equal(calls.filter((c) => c[0] === 'refreshQr').length, before + 1)
  assert.match(text(), /ZZZZ9999/, '新配对码应出现在链接里')
})

test('控制对象切到后端 CLI：探测结果与 PIN 归属如实说明', async () => {
  await click(byText(/后端 CLI 会话/))
  await click(byText(/探测并生成二维码/))
  assert.ok(calls.some((c) => c[0] === 'probeBridge'))
  assert.match(text(), /bridge 可达 · http:\/\/192\.168\.1\.7:9222/)
  assert.match(text(), /PIN 由终端侧签发/)
  // 切回桌面档：远程控制服务的面板不受影响
  await click(byText(/桌面工作区/))
  assert.match(text(), /等待手机连接/)
})

test('未定角色时不渲染空的「手机 ·」标签（真窗口实拍发现的瑕疵）', async () => {
  setStatus({ status: 'running', phoneConnected: true, role: null, pending: [], devices: [] })
  emit({ kind: 'status' })
  await flush()
  assert.ok(!/手机 ·\s*$/.test(text()), 'role 为空时不应出现「手机 ·」')
  setStatus({ phoneConnected: false, role: null })
  emit({ kind: 'status' })
  await flush()
})

test('文案不出现含糊状态：每条状态都带动作+目标+进度', async () => {
  const vague = ['处理中…', '正在工作', '尝试连接']
  for (const v of vague) assert.ok(!text().includes(v), `面板不应出现含糊状态文案：${v}`)
})

test('权限边界提示在面板上明写', async () => {
  assert.match(text(), /工具执行权限始终由桌面端判定/)
})
