// wiringRuntime.test.mjs — 接线运行态验证（[DESIGN-ARCH-171]）。
//
// 与 check-f2e-wiring.js 的分工：
//   · check-f2e-wiring.js  —— 静态审计源码里的通道字符串（改前误报 25 项，见 171 §1.3）
//   · 本文件               —— 真的调用 registerKeyManagerIpc()，看运行态实际注册了什么
// 两者互为独立口径：静态判据可以因正则收窄而失真，运行态不会。
//
// 第三组断言覆盖「按钮响应」：renderer 每处 `await api.xxx()` 必须消费返回值
// （r.ok / r.data / r.error），否则用户点了会静默无反应。
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/wiringRuntime.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

// Pin the data home BEFORE the keyManager modules load. The resolver chain is
// env → portable root → repo root → home; this repo root carries a `.portable`
// marker, so with nothing pinned the chain lands on `<repo>/.khy` and the
// handlers below write key_manager_audit.jsonl into the repository root. That
// is the B8 shadow-dir violation CLAUDE.md §二 B8 forbids, and it makes
// check-repo-layout's root-shadow-dir check red. Same seam, same reasoning as
// agentWriters.test.mjs — only the WRITE location moves; backend resolution
// still sees the real repo, so the assertions below behave exactly as before.
const tmpHome = mkdtempSync(join(os.tmpdir(), 'khy-wiring-'))
process.env.KHY_DATA_HOME = join(tmpHome, 'khy')
after(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    /* temp dir left behind in the OS temp area is harmless */
  }
})

const { registerKeyManagerIpc } = await import('../src/main/keyManager/ipc.ts')

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => (existsSync(join(projectRoot, p)) ? readFileSync(join(projectRoot, p), 'utf-8') : '')

// preload 侧真实暴露的 25 个通道（真源：src/preload/index.ts:176-212）
const PRELOAD_CHANNELS = [
  'keys:list', 'keys:add', 'keys:update', 'keys:remove', 'keys:toggle', 'keys:reveal', 'keys:import',
  'providers:list', 'providers:add', 'providers:remove',
  'endpoints:presets', 'endpoints:validate', 'models:fetch',
  'cards:list', 'cards:add', 'cards:update', 'cards:remove',
  'agents:matrix', 'agents:apply', 'agents:revert',
  'proxy:status', 'proxy:start',
  'health:probe', 'health:audit-list', 'health:audit-export'
]

function captureRegistration() {
  const handlers = new Map()
  const ipc = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  registerKeyManagerIpc(ipc)
  return handlers
}

test('运行态：registerKeyManagerIpc 实际注册 preload 暴露的全部 25 个通道', () => {
  const handlers = captureRegistration()
  const missing = PRELOAD_CHANNELS.filter((ch) => !handlers.has(ch))
  assert.equal(handlers.size, 25, `实际注册 ${handlers.size} 个，期望 25`)
  assert.deepEqual(missing, [], `未注册：${missing.join(', ')}`)
})

test('运行态：注册无重复（重复注册静默覆盖，是真实事故形态）', () => {
  const channels = []
  const ipc = { handle(ch) { channels.push(ch) }, on() {} }
  registerKeyManagerIpc(ipc)
  const dup = [...new Set(channels.filter((ch, i) => channels.indexOf(ch) !== i))]
  assert.deepEqual(dup, [], `重复注册：${dup.join(', ')}`)
})

test('运行态：25 个 handler 全是函数（非 undefined 占位）', () => {
  const handlers = captureRegistration()
  for (const ch of PRELOAD_CHANNELS) {
    assert.equal(typeof handlers.get(ch), 'function', `${ch} 的 handler 不是函数`)
  }
})

test('运行态：只读通道真调用返回 {ok:true,data}（非空壳）', async () => {
  const handlers = captureRegistration()
  const ev = { sender: { id: 1 } }
  const readOnly = ['keys:list', 'providers:list', 'endpoints:presets', 'cards:list', 'agents:matrix', 'proxy:status', 'health:audit-list']
  for (const ch of readOnly) {
    const r = await handlers.get(ch)(ev, undefined)
    assert.equal(r?.ok, true, `${ch} 未返回 ok:true，得到 ${JSON.stringify(r)?.slice(0, 120)}`)
    assert.ok('data' in r, `${ch} 返回缺少 data 字段`)
  }
})

// ── 按钮响应契约：每个 api.xxx() 调用点的返回值必须被消费 ────────────────────
//
// 判据是**结构**而非**文案**：找每个 `api.foo(` 调用点，看它是否处于
//   ① `const x = await api.foo(` / `let x = …`  —— 绑定到变量，或
//   ② `api.foo().then((r) => …)`               —— 回调消费
// 若两者皆非（裸 `await api.foo()` 或裸 `api.foo()`），说明用户点击后拿不到结果，
// 正是「按钮没反应」的形态。
//
// 职责边界（2026-10-01 反向断言实测确定）：
//   · 本测试负责 —— 接线缺失（调了不接返回值、无失败回流、无成功反馈出口）
//   · tsc 负责   —— 符号不存在（如把 setMsg 写成 setMsgXXX，TS2552 会报）
// 因此**不要**把断言写成「页面里必须出现 setMsg({kind:'err'}) 字面量」：那种
// 文案断言既抓不住结构变异，又会因无关改名误红（[DESIGN-ARCH-156] §5
// 「低精度守卫比没有守卫更糟」）。已实测：结构判据对「否定判定改 if(true)」
// 「移除成功反馈」「加裸 await」三类变异全部报红。
test('按钮响应：每个 api 调用点的返回值都被消费（结构判据）', () => {
  const src = read('src/renderer/components/keymanager/KeyManagerPage.tsx')
  assert.ok(src.length > 0, 'KeyManagerPage.tsx 缺失')

  const unconsumed = []
  const lines = src.split(/\r?\n/)
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    // 只看「发起调用且不接返回值」的形态
    const m = /^(?:void\s+)?(?:await\s+)?api\.([a-zA-Z]+)\(/.exec(trimmed)
    if (!m) return
    // 绑定到变量 / 被 .then 消费 / 被 return —— 都算消费
    const consumed = /(?:const|let|var)\s+[\w{[\s,]+\]\s*=/.test(trimmed) || /\.then\(|\.catch\(/.test(trimmed) || /^return\s/.test(trimmed)
    if (!consumed) unconsumed.push(`${i + 1}: ${trimmed.slice(0, 80)}`)
  })

  assert.deepEqual(unconsumed, [], `以下调用未消费返回值（点击后将无反馈）：\n${unconsumed.join('\n')}`)
})

test('按钮响应：存在失败回流（否定判定 + 提前返回）与成功反馈', () => {
  const src = read('src/renderer/components/keymanager/KeyManagerPage.tsx')
  // 失败回流：`if (!X.ok) {` 后 200 字符内出现 return 或错误提示
  const hasFailurePath = /if\s*\(\s*!\s*[a-zA-Z_$][\w$]*\.ok\s*\)\s*\{[\s\S]{0,300}?(?:return|setMsg|setError)/.test(src)
  assert.ok(hasFailurePath, '缺少失败回流：应有 `if (!X.ok) { …return/提示… }`')
  // 成功反馈：页面必须有某种「操作成功」的可观测出口
  const hasSuccessSignal = /setMsg\(\{\s*kind:\s*'ok'|setMsg\(\{\s*kind:\s*"ok"/.test(src)
  assert.ok(hasSuccessSignal, '缺少成功反馈出口（用户看不到操作已完成）')
})

test('按钮响应：页面的交互按钮数量与 api 调用数量匹配（无「点了没反应」的装饰按钮）', () => {
  const src = read('src/renderer/components/keymanager/KeyManagerPage.tsx')
  const onClickHandlers = [...src.matchAll(/onClick=\{(?:async\s+)?\(\)\s*=>\s*\{?/g)]
  // 这些是纯 UI 态切换（切 tab / 展开表单 / 关闭弹窗），不需要 API
  const uiOnly = [...src.matchAll(/onClick=\{\(\)\s*=>\s*(?:set[A-Z][a-zA-Z]*|toggle[A-Z]|api\.closeWindow)/g)]
  const actionButtons = onClickHandlers.length - uiOnly.length
  assert.ok(actionButtons > 0, '未识别到任何动作按钮')
  // 动作按钮应主要由 api 调用承担；api 调用点数量不应少于动作按钮的 1/2
  const apiCalls = [...src.matchAll(/api\.[a-zA-Z]+\(/g)]
  assert.ok(apiCalls.length >= actionButtons / 2, `动作按钮 ${actionButtons} 个但 api 调用仅 ${apiCalls.length} 处`)
})

// ── Amoo 秘书接线（2026-10-31 从 host/main/preload 三个共享文件整体抽到
// amooSecretaryIpc / amooSecretaryBridge / preload/amooSecretary，三个共享文件
// 只留薄挂钩）。源码契约（广播寻址、通道配对、归一持有者）在
// amooSecretary.test.mjs（拼接文本断言）；本节是那套接线的**运行态**：真的
// 调 createAmooSecretaryIpc / installAmooSecretaryBridge / createAmooSecretaryApi，
// 用假车道 / 假 ipcMain / 假 ipcRenderer 看运行态实际发生了什么。广播分支除外
// ——它要真的 BrowserWindow，node:test 里行为化不了（同 amooSecretary.test.mjs
// 的口径），只测不触发的路由分档。

const amooIpcMod = await import('../src/host/amooSecretaryIpc.ts')
const amooBridge = await import('../src/main/amooSecretaryBridge.ts')
const amooPreload = await import('../src/preload/amooSecretary.ts')

const flush = () => new Promise((resolve) => setImmediate(resolve))

// host 接线的回包走模块内的 process.send（无 send 时落日志）：node --test 每个
// 文件是独立子进程，临时换上收集器再还原，不污染其它测试。
const withProcessSend = async (fn) => {
  const sent = []
  const original = process.send
  process.send = (m) => (sent.push(m), true)
  try {
    return await fn(sent)
  } finally {
    if (original === undefined) delete process.send
    else process.send = original
  }
}

function fakeAmooLane(overrides = {}) {
  const calls = []
  return {
    calls,
    probe: overrides.probe || (async () => ({ ok: true, assistantAvailable: true })),
    ask: overrides.ask || (async () => ({ ok: true, askId: 'j1', unverified: true })),
    result: overrides.result || (async () => ({ state: '', unverified: true })),
    stop: overrides.stop || (async () => ({ ok: true })),
    memory: overrides.memory || (async () => ({ ok: true })),
    loopStatus: overrides.loopStatus || (async () => ({ ok: true, running: false })),
    release: overrides.release || (() => calls.push('release')),
  }
}

test('amoo 秘书·host 接线：release 立即转告车道，不相关消息不吞', () => {
  const lane = fakeAmooLane()
  const ipc = amooIpcMod.createAmooSecretaryIpc(lane)
  assert.equal(ipc.handleMessage({ type: 'ai.generate', id: 'x' }), false, '别人的消息不许被吞')
  assert.equal(ipc.handleMessage({ type: 'amooSecretary.release' }), true)
  assert.deepEqual(lane.calls, ['release'], 'release 必须直达车道，且不占 id')
})

test('amoo 秘书·host 接线：六个 RPC 分派到车道并按 op 回 result', async () => {
  const lane = fakeAmooLane()
  const ipc = amooIpcMod.createAmooSecretaryIpc(lane)
  await withProcessSend(async (sent) => {
    const run = async (msg) => {
      assert.equal(ipc.handleMessage(msg), true, `${msg.type} 应被接线消费`)
      await flush()
    }
    await run({ type: 'amooSecretary.probe', id: 'p1' })
    await run({ type: 'amooSecretary.ask', id: 'a1', prompt: '你好', timeoutMs: 60000 })
    await run({ type: 'amooSecretary.result', id: 'r1' })
    await run({ type: 'amooSecretary.stop', id: 's1' })
    await run({ type: 'amooSecretary.loop_status', id: 'l1' })
    assert.deepEqual(sent.map((m) => m.type), Array(5).fill('amooSecretary.result'), '每个 RPC 都要回一条 result')
    assert.deepEqual(
      sent.map((m) => m.op),
      ['probe', 'ask', 'result', 'stop', 'loop_status'],
    )
    assert.equal(sent[0].id, 'p1')
    assert.equal(sent[1].id, 'a1')
  })
})

test('amoo 秘书·host 接线：memory 的 entryId 透传成车道条目键（id 不顶掉）', async () => {
  const memArgs = []
  const lane = fakeAmooLane({ memory: async (...args) => { memArgs.push(args); return { ok: true, entryCount: 1 } } })
  const ipc = amooIpcMod.createAmooSecretaryIpc(lane)
  assert.equal(ipc.handleMessage({ type: 'amooSecretary.memory', id: 'm1', op: 'set', entryId: 'k1', text: 'v1', verified: true, provenance: 'desktop' }), true)
  await flush()
  assert.deepEqual(memArgs, [['set', 'k1', 'v1', true, 'desktop']], '五个字段必须按位透传给车道')
})

test('amoo 秘书·host 接线：车道抛错也回 ok:false（失败不许静默丢）', async () => {
  const lane = fakeAmooLane({ probe: async () => { throw new Error('桥炸了') } })
  const ipc = amooIpcMod.createAmooSecretaryIpc(lane)
  await withProcessSend(async (sent) => {
    assert.equal(ipc.handleMessage({ type: 'amooSecretary.probe', id: 'p2' }), true)
    await flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].ok, false, '失败必须回流给渲染层')
    assert.match(sent[0].error, /Amoo 秘书车道失败/)
    assert.match(sent[0].error, /桥炸了/, '根因要进错误消息')
  })
})

test('amoo 秘书·main 桥：注册全部渲染层通道，host 缺席时诚实报未启动（不伪造在线）', async () => {
  const handlers = new Map()
  const listeners = new Map()
  const ipc = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) }
  amooBridge.installAmooSecretaryBridge(ipc, () => null)
  const expected = ['amooSecretary:status', 'amooSecretary:ask', 'amooSecretary:result', 'amooSecretary:stop', 'amooSecretary:loopStatus', 'amooSecretary:stopPolling', 'amooSecretary:memory']
  assert.deepEqual([...handlers.keys()].sort(), [...expected].sort(), '六个 RPC + stopPolling 全部要注册')
  assert.ok(listeners.has('amooSecretary:release'), '退订通道 ipcMain.on 也要注册')

  const absent = await handlers.get('amooSecretary:status')()
  assert.equal(absent.ok, false, 'host 未启动不许伪造成功')
  assert.match(absent.error.message, /host 进程未启动/)
})

test('amoo 秘书·main 桥：ask 请求发到 host、result 认领回填同一 id（无主事件不寻这张表）', async () => {
  const handlers = new Map()
  const ipc = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} }
  const sentToHost = []
  let host = { connected: true, send: (m) => (sentToHost.push(m), true) }
  amooBridge.installAmooSecretaryBridge(ipc, () => host)

  const pending = handlers.get('amooSecretary:ask')({}, { prompt: '你好', timeoutMs: 60000 })
  await flush()
  assert.equal(sentToHost.length, 1)
  const req = sentToHost[0]
  assert.equal(req.type, 'amooSecretary.ask')
  assert.equal(req.prompt, '你好')
  assert.equal(req.timeoutMs, 60000)
  assert.match(req.id, /^amoo_sec_\d+_\d+$/)

  assert.equal(amooBridge.handleAmooSecretaryHostMessage({ type: 'ai.chunk', id: 'x' }), false, 'ai.* 仍归 main 原路由')
  assert.equal(amooBridge.handleAmooSecretaryHostMessage({ type: 'amooSecretary.result', id: req.id, ok: true, askId: 'j1', unverified: true }), true)
  assert.deepEqual(await pending, { type: 'amooSecretary.result', id: req.id, ok: true, askId: 'j1', unverified: true })
  // 认领后同一 id 再来一条：表里已无条目，不得误 resolve 别的等待方
  assert.equal(amooBridge.handleAmooSecretaryHostMessage({ type: 'amooSecretary.result', id: req.id, ok: false }), true)
})

test('amoo 秘书·main 桥：release 三条路都只转告车道停轮询，不动手机侧任务', async () => {
  const handlers = new Map()
  const listeners = new Map()
  const ipc = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) }
  const sentToHost = []
  const host = { connected: true, send: (m) => (sentToHost.push(m), true) }
  amooBridge.installAmooSecretaryBridge(ipc, () => host)

  assert.deepEqual(await handlers.get('amooSecretary:stopPolling')(), { ok: true })
  listeners.get('amooSecretary:release')()
  amooBridge.releaseAmooSecretary(host)
  assert.deepEqual(sentToHost, Array(3).fill({ type: 'amooSecretary.release' }))
})

test('amoo 秘书·main 桥：release 空值安全——host 为 null / 未连接 / 发送抛错都不上抛', () => {
  amooBridge.releaseAmooSecretary(null)
  amooBridge.releaseAmooSecretary({ connected: false, send: () => { throw new Error('nope') } })
  const sent = []
  amooBridge.releaseAmooSecretary({ connected: true, send: (m) => (sent.push(m), true) })
  assert.deepEqual(sent, [{ type: 'amooSecretary.release' }])
})

test('amoo 秘书·preload 片段：七个方法各配对正确通道，退订即发 release', async () => {
  const invokes = []
  const fakeIpcRenderer = {
    invoke: async (ch, payload) => ({ ch, payload }),
    on: () => {},
    removeListener: () => {},
    send: () => {},
  }
  const api = amooPreload.createAmooSecretaryApi(fakeIpcRenderer)

  assert.deepEqual(await api.amooSecretaryStatus(), { ch: 'amooSecretary:status', payload: undefined })
  assert.deepEqual(await api.amooSecretaryAsk({ prompt: '你好', timeoutMs: 60000 }), { ch: 'amooSecretary:ask', payload: { prompt: '你好', timeoutMs: 60000 } })
  assert.deepEqual(await api.amooSecretaryResult(), { ch: 'amooSecretary:result', payload: undefined })
  assert.deepEqual(await api.amooSecretaryStopPolling(), { ch: 'amooSecretary:stopPolling', payload: undefined })
  assert.deepEqual(await api.amooSecretaryLoopStatus(), { ch: 'amooSecretary:loopStatus', payload: undefined })
  assert.deepEqual(
    await api.amooSecretaryMemory({ op: 'get', id: 'k1' }),
    { ch: 'amooSecretary:memory', payload: { op: 'get', id: 'k1' } },
  )
})

test('amoo 秘书·preload 片段：stop 读嵌套 error.message 并抛出（中止失败必须让调用方看见）', async () => {
  const fakeIpcRenderer = { invoke: async () => ({ ok: false, error: { code: 'refused', message: '手机侧拒绝了' } }), on: () => {}, removeListener: () => {}, send: () => {} }
  const api = amooPreload.createAmooSecretaryApi(fakeIpcRenderer)
  await assert.rejects(() => api.amooSecretaryStop(), /手机侧拒绝了/, '面板靠 throw 区分「已中止」与「没中止成功」')

  const okIpc = { invoke: async () => ({ ok: true, message: '已送达' }), on: () => {}, removeListener: () => {}, send: () => {} }
  assert.deepEqual(await amooPreload.createAmooSecretaryApi(okIpc).amooSecretaryStop(), { ok: true, message: '已送达' })
})

test('amoo 秘书·preload 片段：退订事件时向 main 发 release（没人看的进度不许继续轮询）', () => {
  const ops = []
  let listenerRef = null
  const fakeIpcRenderer = {
    invoke: async () => ({}),
    on: (_ch, fn) => { listenerRef = fn },
    removeListener: (ch, fn) => ops.push(['off', ch, fn === listenerRef]),
    send: (ch) => ops.push(['send', ch]),
  }
  const api = amooPreload.createAmooSecretaryApi(fakeIpcRenderer)
  const unsubscribe = api.onAmooSecretaryEvent(() => {})
  assert.equal(typeof unsubscribe, 'function', '订阅必须返回退订函数')
  unsubscribe()
  assert.deepEqual(ops, [['off', 'amooSecretary:event', true], ['send', 'amooSecretary:release']])
})
