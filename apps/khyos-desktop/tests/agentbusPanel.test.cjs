// AgentbusSection 的真实 DOM 测试：esbuild 打包 + jsdom 挂载，覆盖
// 「status ok 才启用发送」「点击才发送」「回复块徽标 + 免责 + 截断行」
// 「用量行数字与 measured 后缀」「运行中出现中止且点击调 stop」
// 「失败态渲染 message + hint」「卸载不抛」。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')

const APP_DIR = path.resolve(__dirname, '..')

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khyagb-ui-')), 'harness.cjs')
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'agentbusPanel.harness.tsx')],
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

const harness = require(bundlePath)
const { mount, unmount, setStatus, setResult, setAsk, setSettingsReply, emitEvent, calls } = harness

const flush = async (times = 8) => {
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
const typeInput = async (value) => {
  const input = document.querySelector('#root input')
  assert.ok(input, '应渲染串号输入框')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await flush()
}

const OK_STATUS = {
  ok: true,
  code: 'ok',
  message: '已连上手机端 Amoo 后台服务（1.0.0）',
  hint: '',
  serial: 'SERIAL1',
  serialSource: 'agentbus',
  serverVersion: '1.0.0',
  protocol: 3,
}

// Teardown is defensive on purpose: if unmount() throws, dom.window.close() would
// never run and jsdom's virtual console/timers would keep the process alive —
// turning one component error into a file-level hang.
test.after(() => {
  try {
    unmount()
  } catch {
    /* already gone */
  }
  try {
    dom.window.close()
  } catch {
    /* already closed */
  }
})

test.beforeEach(() => {
  unmount()
  calls.length = 0
  setStatus(OK_STATUS)
  setResult({ state: 'idle', elapsedMs: 0, budgetMs: 420000, unverified: true })
  setAsk({ ok: true, jobId: 'agb_1', budgetMs: 420000, unverified: true })
  setSettingsReply({ agentbusSerial: 'SERIAL1' })
})

test('status ok 才启用发送；未探测/失败态禁用', async () => {
  mount()
  await flush()
  const send = byText(/发送/)
  assert.ok(send, '应有发送按钮')
  assert.equal(send.disabled, true, '空输入时禁用')
  await type('你好')
  assert.equal(send.disabled, false, 'status ok 且有输入才启用')

  unmount()
  calls.length = 0
  setStatus({ ok: false, code: 'serial_not_connected', message: '设备表里没有串号 SERIAL1 的手机', hint: 'adb devices' })
  mount()
  await flush()
  assert.match(text(), /设备表里没有串号/)
  assert.match(text(), /adb devices/)
  assert.equal(byText(/发送/).disabled, true, '探测失败不许发送')
})

test('点击才发送：不点击一次都不发', async () => {
  mount()
  await flush()
  await type('你好')
  assert.equal(calls.filter(([kind]) => kind === 'ask').length, 0, '打字不该触发发送')
  await click(byText(/发送/))
  assert.equal(calls.filter(([kind]) => kind === 'ask').length, 1)
  const ask = calls.find(([kind]) => kind === 'ask')
  assert.equal(ask[1].prompt, '你好')
  assert.match(text(), /0\/20000|你好/)
})

test('回复块：未验证徽标 + 免责 + 截断披露 + 用量行数字与 measured 后缀', async () => {
  mount()
  await flush()
  setResult({
    state: 'done',
    elapsedMs: 4200,
    budgetMs: 420000,
    reply: '手机说好的',
    replyTruncated: true,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      total_tokens: 33,
      context_used: 30,
      context_limit: 128000,
      tokens_per_second: 5.5,
      response_ms: 4000,
      response_ms_source: 'measured',
    },
    sessionKey: 'agent:main:desktop-x',
    runId: 'stepx-1',
    unverified: true,
  })
  emitEvent({ type: 'state', jobId: 'agb_1', state: 'done' })
  await flush()
  const body = text()
  assert.match(body, /未验证/)
  assert.match(body, /回复未经桌面校验/)
  assert.match(body, /手机说好的/)
  assert.match(body, /回复可能被截断：完整文本只在手机上/)
  assert.match(body, /输入 11 · 输出 22/)
  assert.match(body, /5\.5 tok\/s/)
  assert.match(body, /（桌面实测耗时，非服务端上报）/)
  assert.match(body, /上下文 30 \/ 128000/)
  assert.match(body, /Token 来自服务返回的消息记录，不根据字符数估算，未经桌面校验/)
})

test('服务端没给耗时且输出为 0 时不画 tok/s', async () => {
  mount()
  await flush()
  setResult({
    state: 'done',
    elapsedMs: 1000,
    budgetMs: 420000,
    reply: '空的',
    usage: { input_tokens: 5, output_tokens: 0, context_used: 5, context_limit: null, tokens_per_second: null, response_ms: null, response_ms_source: null },
    unverified: true,
  })
  emitEvent({ type: 'state', jobId: 'agb_1', state: 'done' })
  await flush()
  const body = text()
  assert.match(body, /不画 tok\/s/)
  assert.doesNotMatch(body, /（桌面实测耗时，非服务端上报）/)
})

test('运行中出现中止，点击调 stop', async () => {
  mount()
  await flush()
  setResult({ state: 'waiting', elapsedMs: 12000, budgetMs: 420000, unverified: true })
  emitEvent({ type: 'phase', jobId: 'agb_1', phase: 'waiting' })
  await flush()
  assert.match(text(), /已等 12s \/ 上限 420s/)
  assert.match(text(), /手机熄屏时这一轮可能迟迟没有响应/)
  const stop = byText(/中止/)
  assert.ok(stop, '运行中应出现中止按钮')
  await click(stop)
  assert.equal(calls.filter(([kind]) => kind === 'stop').length, 1)
})

test('等待期每秒本地重拉结果，卸载后停止（FE-06：hub 在静默等待里零广播）', async (t) => {
  mount()
  await flush()
  setResult({ state: 'waiting', elapsedMs: 0, budgetMs: 420000, unverified: true })
  // 只 mock setInterval：flush 靠真 setTimeout 推进微任务，连 setTimeout 一起
  // mock 会把 flush 自己也冻住。
  t.mock.timers.enable({ apis: ['setInterval'] })
  emitEvent({ type: 'phase', jobId: 'agb_1', phase: 'waiting' })
  await flush()
  const baseline = calls.filter(([kind]) => kind === 'result').length
  t.mock.timers.tick(1000)
  t.mock.timers.tick(1000)
  t.mock.timers.tick(1000)
  await flush()
  const pulled = calls.filter(([kind]) => kind === 'result').length - baseline
  assert.ok(pulled >= 3, `等待 3 秒应至少重拉 3 次结果，实际 ${pulled} 次`)
  unmount()
  const afterUnmount = calls.filter(([kind]) => kind === 'result').length
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(
    calls.filter(([kind]) => kind === 'result').length,
    afterUnmount,
    '卸载后计时器必须停，不许继续重拉',
  )
  t.mock.timers.reset()
})

test('串号设置：显示当前生效值，保存写 agentbusSerial 并如实提示重启生效', async () => {
  mount()
  await flush()
  assert.match(text(), /当前生效：SERIAL1/, '车道解析到的串号要渲染出来')
  const input = document.querySelector('#root input')
  assert.ok(input, '应渲染串号输入框')
  assert.equal(input.value, 'SERIAL1', '输入框回填已保存的设置项')
  await typeInput('PHONE42')
  await click(byText(/^保存$/))
  const saved = calls.find(([kind]) => kind === 'setSetting')
  assert.ok(saved, '保存必须走 setSetting')
  assert.equal(saved[1], 'agentbusSerial')
  assert.equal(saved[2], 'PHONE42')
  assert.match(text(), /重启桌面端后生效/, '改串号只在重启后生效，必须如实写出')
})

test('失败态渲染 message + hint 与分类', async () => {
  unmount()
  setStatus({ ok: false, code: 'adb_not_found', message: 'PATH 里没有 adb，也没有配置 KHY_AGENTBUS_ADB_PATH', hint: 'KHY_AGENTBUS_ADB_PATH=<adb 可执行文件路径>' })
  mount()
  await flush()
  const body = text()
  assert.match(body, /PATH 里没有 adb/)
  assert.match(body, /KHY_AGENTBUS_ADB_PATH=/)

  setResult({ state: 'failed', elapsedMs: 300, budgetMs: 420000, error: { code: 'stream_lost', message: '与手机的连接中断：这一轮的状态无法确认' }, unverified: true })
  emitEvent({ type: 'state', jobId: 'agb_1', state: 'failed' })
  await flush()
  assert.match(text(), /与手机的连接中断/)
  assert.match(text(), /stream_lost/)
})

test('预算用尽与失败态的回退文案都不劝重试', async () => {
  mount()
  await flush()

  // budget_exhausted 没有 error：回退文案必须如实说「桌面端停了等待，
  // 手机可能仍在执行」——这里写「请重试」就是让用户再花一次配额。
  setResult({ state: 'budget_exhausted', elapsedMs: 420000, budgetMs: 420000, unverified: true })
  emitEvent({ type: 'state', jobId: 'agb_1', state: 'budget_exhausted' })
  await flush()
  const exhausted = text()
  assert.match(exhausted, /本轮预算用尽：桌面端已停止等待，手机可能仍在执行/)
  assert.match(exhausted, /budget_exhausted/)
  assert.doesNotMatch(exhausted, /请重试/, '预算用尽不许劝重试')

  // failed 且没有 message 时的回退同样只让用户去手机上核对
  setResult({ state: 'failed', elapsedMs: 300, budgetMs: 420000, unverified: true })
  emitEvent({ type: 'state', jobId: 'agb_1', state: 'failed' })
  await flush()
  const failed = text()
  assert.match(failed, /这一轮没有结果：请先在手机上核对，不要直接重复提交/)
  assert.doesNotMatch(failed, /请重试/, '失败态也不许劝重试')
})

test('卸载不抛，且退订事件', async () => {
  mount()
  await flush()
  unmount()
  emitEvent({ type: 'state', jobId: 'agb_1', state: 'done' })
  await flush()
  mount()
  await flush()
  unmount()
  assert.ok(true)
})

// ── 源码契约（原 agentbusUiContract.test.cjs，合并以压住 change-safety 的文件数上限）──
// 这条车道的危险漂移全是「字符串 + 状态机」形状的——磁贴没接上、回复被渲染成已核实、
// 含糊词溜进状态行、remoteSpec 原文泄到用户可见串、第二次 createWindow 把通道注册
// 抛出来——类型检查一个都抓不到，所以直接读源文件断言。

const read = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8')

// 本车道新增的源文件（不含测试）。RUNTIME-002 词表由本测试自带、只扫这些文件：
// 词表必须活在测试里才能被断言，而 check-agent-rules.js:637/:807 对测试文件本就
// 两项豁免，所以测试文件自己不受这条禁令约束。
const SRC = [
  'src/main/agentbus/agentbusProtocol.ts',
  'src/main/agentbus/agentbusTransport.ts',
  'src/main/agentbus/agentbusClient.ts',
  'src/main/agentbus/agentbusRound.ts',
  'src/main/agentbus/index.ts',
  'src/main/agentbusBridge.ts',
  'src/preload/agentbus.ts',
  'src/renderer/components/amoon/AgentbusSection.tsx',
]
const src = SRC.map(read).join('\n')
const pane = read('src/renderer/components/amoon/AgentbusSection.tsx')
const mainIndex = read('src/main/index.ts')
const preloadIndex = read('src/preload/index.ts')
const secretaryPane = read('src/renderer/components/amoon/AmooSecretaryPane.tsx')
const clientSrc = read('src/main/agentbus/agentbusClient.ts')
const bridgeSrc = read('src/main/agentbusBridge.ts')
const settingsSrc = read('src/main/settingsStore.ts')

test('接线四处：main 两个 import + 进程级单例 + install，preload import + spread，秘书面板末尾挂载', () => {
  assert.match(mainIndex, /import \{ createAgentbusHub, type AgentbusHub \} from '\.\/agentbus\/index'/, 'main 必须 import createAgentbusHub')
  assert.match(mainIndex, /import \{ installAgentbusBridge \} from '\.\/agentbusBridge'/, 'main 必须 import installAgentbusBridge')
  assert.match(mainIndex, /let agentbusHub: AgentbusHub \| null = null/, 'amoonHub 旁要建进程级单例')
  assert.match(
    mainIndex,
    /agentbusHub = createAgentbusHub\(\{[\s\S]{0,120}?installAgentbusBridge\(\{ ipc, hub: agentbusHub \}\)/,
    'installAgentbusLane 必须建进程级单例并 install',
  )
  assert.match(
    mainIndex,
    /installAmooSecretaryBridge\(ipcMain, \(\) => hostProcess\)\s*\n\s*installAgentbusLane\(ipcMain, settings\.agentbusSerial\)/,
    'installAmooSecretaryBridge 旁要调用 installAgentbusLane 并传入设置项串号',
  )
  assert.match(mainIndex, /logger: laneLog/, '两条 amoo 车道共用一个诊断出口，不各写一个 console.log')
  assert.match(preloadIndex, /import \{ createAgentbusApi \} from '\.\/agentbus'/, 'preload 必须 import createAgentbusApi')
  assert.match(preloadIndex, /\.\.\.createAgentbusApi\(ipcRenderer\)/, 'preload 必须 spread 这个片段')
  assert.match(secretaryPane, /import \{ AgentbusSection \} from '\.\/AgentbusSection'/, '秘书面板必须 import 小节')
  assert.match(
    secretaryPane,
    /<AmooSecretaryMemory[\s\S]{0,600}?<AgentbusSection \/>/,
    '小节必须挂在 AmooSecretaryMemory 之后（面板末尾）',
  )
})

test('RUNTIME-002 词表由测试自带，只扫新 src 文件（含注释）', () => {
  const banned = ['正在工作', '处理中', '尝试连接', '请稍候', '正在加载', '加载中', 'loading', 'processing', 'connecting']
  for (const rel of SRC) {
    const text = read(rel)
    const lower = text.toLowerCase()
    for (const token of banned) {
      assert.ok(!lower.includes(token.toLowerCase()), `${rel} 不许出现含糊词：${token}`)
    }
  }
})

test('本车道不引用 amoo 其它车道的状态源', () => {
  // 禁的是**调用**，不是注释里提到先例文件名：agentbusBridge.ts 的头注就写了
  // 「同 amooSecretaryBridge 的拆法」，那是归因，不是依赖。
  const banned = [
    'AmooStatusProvider',
    'amooPanelViewModel',
    'buildAmooPanelModel',
    'amoonSend',
    'amoonInbox',
    'amooSecretaryStatus',
    'amooSecretaryAsk',
    'amooSecretaryResult',
    'amooSecretaryStop',
    'amooSecretaryMemory',
    'amooSecretaryLoopStatus',
    'amooSecretaryEvent',
    'amooSecretary:',
  ]
  for (const rel of SRC) {
    const text = read(rel)
    for (const token of banned) {
      assert.ok(!text.includes(token), `${rel} 不得引用 ${token}`)
    }
  }
})

test('渲染层纯度：只走 preload 注入的 API', () => {
  assert.doesNotMatch(pane, /\bfetch\s*\(/, '渲染层不得直接 fetch')
  assert.doesNotMatch(pane, /\bfs\.|readFileSync|node:fs|require\(/, '渲染层不得自己读磁盘')
  assert.match(pane, /__KHYOS__/, '只走 preload 注入的 API')
  assert.match(pane, /agentbusStatus|agentbusAsk|agentbusResult|agentbusStop/, '必须走 agentbus 四通道')
  assert.match(pane, /onAgentbusEvent/, '必须订阅无主事件')
  assert.match(pane, /name="chat"/, '图标必须用注册表已有的 chat')
  assert.doesNotMatch(pane, /khy-canary/, '不手写金丝雀标记')
})

test('回复恒带未验证，类型层不存在 verified:true', () => {
  assert.match(src, /unverified\s*:\s*true/, '车道结果必须钉成 unverified: true')
  assert.doesNotMatch(src, /(?<!un)verified\s*:\s*true/, '不许出现任何 verified:true 形状')
  assert.match(pane, /未验证/, '回复渲染块必须带未验证徽标')
  assert.match(pane, /回复未经桌面校验/, '徽标旁必须写明清形')
})

test('用量口径：token 来自服务记录、不估算、实测耗时必须标注', () => {
  assert.match(pane, /Token 来自服务返回的消息记录，不根据字符数估算，未经桌面校验/, '用量口径整句必须在面板上')
  assert.match(pane, /（桌面实测耗时，非服务端上报）/, 'measured 来源必须追加披露')
  assert.match(pane, /不画 tok\/s/, '没有耗时或输出为 0 时不画 tok/s')
  assert.match(src, /response_ms_source/, '用量必须带耗时来源字段')
  assert.match(src, /responseMsSource|response_ms_source/, '用量族必须能区分 server 与 measured')
  assert.match(src, /withObservedResponseMs/, '桌面实测只能走带标注的那一个入口')
})

test('截断只认消息行自带标志，文案如方案', () => {
  assert.match(src, /truncated: rec\.truncated === true/, '不得从文本长度推断截断')
  assert.match(pane, /回复可能被截断：完整文本只在手机上/, '截断披露文案')
})

test('中止只有单一诚实档', () => {
  assert.match(src, /已停止桌面等待；手机可能仍在执行，请在手机上核对，勿直接重复提交/, 'stop 文案必须原样')
  assert.equal((src.match(/STOP_MESSAGE/g) || []).length >= 1, true, 'stop 文案要收成常量')
  assert.doesNotMatch(pane, /已通知手机端停止/, '不许假装手机已经停下')
})

test('remoteSpec 原文只活在纯协议件里，用户可见串零出现', () => {
  for (const rel of SRC) {
    const hits = (read(rel).match(/localabstract/g) || []).length
    if (rel === 'src/main/agentbus/agentbusProtocol.ts') assert.equal(hits >= 1, true, '配置件必须记默认值来源')
    else assert.equal(hits, 0, `${rel} 不许出现 remoteSpec 原文`)
  }
  // 状态对象不回 remoteSpec：AgentbusStatus 的字段表里没有它（它现居 transport）
  const statusSrc = read('src/main/agentbus/agentbusTransport.ts')
  const typeBlock = statusSrc.slice(statusSrc.indexOf('export type AgentbusStatus'))
  assert.doesNotMatch(typeBlock.slice(0, typeBlock.indexOf('}')), /remoteSpec/, 'facts 不回 remoteSpec 原文')
})

test('hint 只能是探活命令或 env 赋值', () => {
  const hints = [...read('src/main/agentbus/agentbusTransport.ts').matchAll(/hint:\s*'([^']*)'/g)].map((m) => m[1])
  assert.ok(hints.length >= 4, '至少四种失败态各有 hint')
  for (const hint of hints) {
    assert.ok(
      hint === '' || /^adb devices$/.test(hint) || /^KHY_AGENTBUS_[A-Z_]+=/.test(hint),
      `hint 只能是探活命令或 env 赋值：${hint}`,
    )
  }
  // 探活实际跑的命令与提示同形：argv 恰为 ['devices']
  const transportSrc = read('src/main/agentbus/agentbusTransport.ts')
  assert.match(transportSrc, /devices: \(\) => run\(\['devices'\]\)/, '探活必须跑 adb devices')
  assert.match(transportSrc, /'forward', 'tcp:0'/, 'forward 只认 tcp:0 形态')
  assert.match(transportSrc, /'--remove'/, '--remove 必须单独处置')
  assert.doesNotMatch(transportSrc, /'pair'/, 'argv 永不许出现 pair')
})

test('installAgentbusBridge 幂等：四通道先 removeHandler 再 handle', () => {
  assert.match(bridgeSrc, /for \(const channel of HANDLED_CHANNELS\) \{\s*ipc\.removeHandler\(channel\)/, '注册前必须 removeHandler')
  for (const channel of ['agentbus:status', 'agentbus:ask', 'agentbus:result', 'agentbus:stop']) {
    assert.ok(bridgeSrc.includes(`'${channel}'`), `必须登记 ${channel}`)
  }
  assert.match(bridgeSrc, /subscribedHubs/, '事件订阅按 hub 只挂一次，二次 install 不许双广播')
})

test('preload 的 stop 在 ok:false 时抛错', () => {
  const preload = read('src/preload/agentbus.ts')
  assert.match(preload, /r\.ok === false\) throw new Error/, '中止失败必须让调用方看见')
})

test('串号回退只在两个 env 都空时注入；走秒计时器绑运行态且可清理', () => {
  assert.match(settingsSrc, /agentbusSerial:\s*''/, 'DEFAULTS 必须登记 agentbusSerial')
  assert.match(mainIndex, /KHY_AGENTBUS_SERIAL/, '注入点必须认得专属 env')
  assert.match(mainIndex, /KHY_PHONE_BRIDGE_SERIAL/, '注入点必须认得回退 env')
  assert.match(
    mainIndex,
    /!explicit && !fallback && fromSettings/,
    '两个 env 都空才允许 settings 值注入，不许颠倒双 env 优先级',
  )
  assert.match(
    mainIndex,
    /installAgentbusLane\(ipcMain, settings\.agentbusSerial\)/,
    '调用点必须把设置项串号传进去',
  )
  assert.match(pane, /setInterval\(\(\) => void pullResult\(\), 1000\)/, '等待期每秒重拉一次结果')
  assert.match(pane, /if \(!laneRunning\) return/, '计时器只在运行态存在')
  assert.match(pane, /clearInterval\(timer\)/, '计时器必须清理')
  assert.match(pane, /'agentbusSerial'/, '写设置项用固定键名')
})
