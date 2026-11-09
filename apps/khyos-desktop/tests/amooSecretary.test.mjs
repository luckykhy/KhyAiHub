// 桌面端「共享记忆」动词的运行时契约：不启 Electron，用假 client 驱动
// src/host/amooSecretary.ts 的 memory，钉住四件事——调用不带 confirm、
// set 默认 verified=false、provenance 固定记 desktop、get 的返回不被改写。
// 与 amooBridge.test.mjs 同一手法：假 client 记录每次 (tool, args, options)。
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.resolve(here, '../src/host/amooSecretary.ts')).href)
const { createAmooSecretary } = mod

// 上限相关用例不赌调用方式：车道解析 catalog 走 KHY_OS_DIR 或 cwd（host 进程的
// cwd 是 apps/khyos-desktop），这里统一把 KHY_OS_DIR 钉到仓库根（由本文件位置
// 上溯三级），用完恢复。
async function withRepoRoot(fn) {
  const prev = process.env.KHY_OS_DIR
  process.env.KHY_OS_DIR = path.resolve(here, '..', '..', '..')
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.KHY_OS_DIR
    else process.env.KHY_OS_DIR = prev
  }
}

function fakeClient(handler) {
  const calls = []
  return {
    calls,
    probe: async () => ({ ok: true, assistantAvailable: true }),
    call: async (tool, args, options) => {
      calls.push({ tool, args, options })
      return handler(tool, args)
    },
  }
}

// 手机侧 amoo_memory get 的真实回包形状（Tools.java:2289-2294；桥客户把桥的
// 字段摊到顶层，_shapeResult 只摊字段、不改值）：entries/verified/unverified
// 是计数，json 是记忆文档本体，injection 是注入文本。
function getPayload(entries, counts, extra = {}) {
  return {
    success: true,
    channel: 'http',
    tool: 'amoo_memory',
    op: 'get',
    entries: counts.total,
    verified: counts.verified,
    unverified: counts.unverified,
    json: JSON.stringify({ version: 1, entries }),
    injection: '· [未证实] 某人这么说过',
    ...extra,
  }
}

test('memory(get) 只带 op，且整个 options 都不传（不带 confirm）', async () => {
  const client = fakeClient(() => getPayload([], { total: 0, verified: 0, unverified: 0 }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('get')
  assert.equal(r.ok, true)
  assert.equal(client.calls.length, 1)
  const call = client.calls[0]
  assert.equal(call.tool, 'amoo_memory')
  assert.deepEqual(call.args, { op: 'get' })
  // classifyBridgeCall('amoo_memory', …).requiresConfirm=false：op 依赖分支只
  // 特判 clipboard（phoneBridgePolicy.js:323-328）。第三个参数整个不传——
  // 传了虽无害，但会让下一个读者以为这是需要批准的写操作。
  assert.equal(call.options, undefined)
})

test('memory(set) 默认 verified=false、provenance 固定记 desktop，同样不传 confirm', async () => {
  const client = fakeClient(() => ({ success: true, op: 'set', entries: 3, verified: 1 }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('set', 'deploy-window', '每周四凌晨部署')
  assert.equal(r.ok, true)
  const call = client.calls[0]
  assert.equal(call.tool, 'amoo_memory')
  assert.deepEqual(call.args, {
    op: 'set',
    id: 'deploy-window',
    text: '每周四凌晨部署',
    verified: false,
    provenance: 'desktop',
  })
  assert.equal(call.options, undefined)
  // 桥上回执：写入后的条目总数与已核实数原样带回
  assert.equal(r.entryCount, 3)
  assert.equal(r.verifiedCount, 1)
  assert.match(r.message, /落盘失败会被静默忽略/)
})

test('勾选「标为已核实」时 verified=true 才上车', async () => {
  const client = fakeClient(() => ({ success: true, op: 'set', entries: 4, verified: 2 }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('set', 'k', '手工确认过的事实', true, 'desktop')
  assert.equal(r.ok, true)
  assert.equal(client.calls[0].args.verified, true)
  assert.equal(client.calls[0].args.provenance, 'desktop')
})

test('get 的返回不被改写：确信度与来源逐字段原样透传，verified 条目不被降级', async () => {
  const entries = [
    { id: 'phone-verified', text: '命令验证通过的事实', confidence: 'verified', provenance: 'verified:write' },
    { id: 'amoo-said', text: 'Amoo 这么说', confidence: 'unverified', provenance: 'amoo-said' },
    { id: 'desktop-wrote', text: '桌面手工写的', confidence: 'unverified', provenance: 'desktop' },
  ]
  const client = fakeClient(() => getPayload(entries, { total: 3, verified: 1, unverified: 2 }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('get')
  assert.equal(r.ok, true)
  // 逐字段原样：id/text/confidence/provenance 一个都不改、一个都不补
  assert.deepEqual(r.entries, entries)
  assert.equal(r.entryCount, 3)
  assert.equal(r.verifiedCount, 1)
  assert.equal(r.unverifiedCount, 2)
  assert.notEqual(r.partial, true)
  // 明确钉住「不许把 get 到的 verified=true 条目去掉标记」
  assert.equal(r.entries[0].confidence, 'verified')
  assert.equal(r.entries[0].provenance, 'verified:write')
})

test('桌面写入且勾了已核实的条目，车道也原样带回（洗白发生在 UI 层之外不存在）', async () => {
  const entries = [{ id: 'desktop-ticked', text: '勾了复选框的事实', confidence: 'verified', provenance: 'desktop' }]
  const client = fakeClient(() => getPayload(entries, { total: 1, verified: 1, unverified: 0 }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('get')
  // 车道不替 UI 做判断：confidence 照桥说的带回，「桌面写入恒记未验证」的
  // 徽标规则在渲染层（MemoryEntryRow），两边不重复实现。
  assert.deepEqual(r.entries, entries)
})

test('get 文档被截断/解析失败时报 partial，不把不完整的列表当作全部', async () => {
  const client = fakeClient(() =>
    getPayload([], { total: 42, verified: 7, unverified: 35 }, {
      json: '{"version":1,"entries":[{"id":"a","text":"被截断',
      truncated: true,
    }),
  )
  const r = await createAmooSecretary({ client, send: () => {} }).memory('get')
  assert.equal(r.ok, true)
  assert.equal(r.partial, true)
  assert.deepEqual(r.entries, [])
  assert.match(r.message, /不是完整记忆/)
  // 计数照桥上计带回，不因为文档不完整就少报
  assert.equal(r.entryCount, 42)
})

test('set 缺 id / 缺 text 在桌面侧就被拒，桥调用一次都不发', async () => {
  const client = fakeClient(() => ({ success: true, op: 'set', entries: 1, verified: 0 }))
  const secretary = createAmooSecretary({ client, send: () => {} })
  const noId = await secretary.memory('set', '', '内容')
  assert.equal(noId.ok, false)
  assert.equal(noId.code, 'invalid_args')
  const noText = await secretary.memory('set', 'k', '   ')
  assert.equal(noText.ok, false)
  assert.equal(noText.code, 'invalid_args')
  assert.equal(client.calls.length, 0)
})

test('set 超长在桌面侧被拒并给出合法范围（上限读自 phoneBridgeCatalog 规格）', async () => {
  await withRepoRoot(async () => {
    const client = fakeClient(() => ({ success: true }))
    const secretary = createAmooSecretary({ client, send: () => {} })
    const longId = await secretary.memory('set', 'x'.repeat(129), '内容')
    assert.equal(longId.ok, false)
    assert.match(longId.message, /128/)
    const longText = await secretary.memory('set', 'k', 'x'.repeat(4001))
    assert.equal(longText.ok, false)
    assert.match(longText.message, /4000/)
    const longProvenance = await secretary.memory('set', 'k', '内容', false, 'x'.repeat(65))
    assert.equal(longProvenance.ok, false)
    assert.match(longProvenance.message, /64/)
    assert.equal(client.calls.length, 0)
  })
})

// 单一真源钉住：期望值是「测试当场从 catalog 读出的规格」，不是抄死的
// 128/4000/64——catalog 改了这里跟着改；车道若再抄一份旧值，这里现形。
test('probe 带 memoryLimits，与直接 require catalog 的 amoo_memory 规格逐字段相等', async () => {
  await withRepoRoot(async () => {
    const catalog = createRequire(import.meta.url)(
      path.resolve(here, '../../../runtime/node/backend/src/services/domain/network/phone/phoneBridgeCatalog.js'),
    )
    const spec = catalog.findPhoneBridgeTool('amoo_memory')
    assert.ok(spec, '夹具前提：catalog 里必须有 amoo_memory 规格')
    const expected = {
      id: spec.args.id.maxLength,
      text: spec.args.text.maxLength,
      provenance: spec.args.provenance.maxLength,
    }
    assert.ok(expected.id > 0 && expected.text > 0 && expected.provenance > 0, '夹具前提：三个上限必须是正数')
    const r = await createAmooSecretary({ client: fakeClient(() => ({})), send: () => {} }).probe()
    assert.equal(r.ok, true)
    assert.deepEqual(r.memoryLimits, expected)
  })
})

test('catalog 读不到时 probe 不带 memoryLimits，长度预检退位（后端 policy 仍是执法者）', async () => {
  const client = fakeClient(() => ({ success: true, op: 'set', entries: 1, verified: 0 }))
  const secretary = createAmooSecretary({ client, send: () => {}, memoryLimits: null })
  const p = await secretary.probe()
  assert.equal('memoryLimits' in p, false, '读不到规格就不带这个字段——不许回退到硬编码副本')
  const r = await secretary.memory('set', 'valid-id', 'x'.repeat(9999))
  assert.equal(r.ok, true, '桌面没有规格时不用旧副本替后端 policy 执法')
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].args.text, 'x'.repeat(9999))
})

test('op 非法被拒，不发桥调用', async () => {
  const client = fakeClient(() => ({ success: true }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('delete')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_op')
  assert.equal(client.calls.length, 0)
})

test('桥拒绝时原样带出手机侧的原因（nested result.error，顶层 code 被改写成 bridge_error）', async () => {
  const client = fakeClient(() => ({
    success: false,
    code: 'bridge_error',
    error: '桥接返回失败',
    result: { ok: false, error: 'op=set 需要 id 与 text' },
  }))
  const r = await createAmooSecretary({ client, send: () => {} }).memory('set', 'k', 'v')
  assert.equal(r.ok, false)
  assert.match(r.message, /op=set 需要 id 与 text/)
  assert.match(r.message, /写入失败/)
})

test('桥调用抛错时不伪装成成功', async () => {
  const client = {
    probe: async () => ({ ok: true }),
    call: async () => {
      throw new Error('adb 不在 PATH')
    },
  }
  const r = await createAmooSecretary({ client, send: () => {} }).memory('get')
  assert.equal(r.ok, false)
  assert.match(r.message, /adb 不在 PATH/)
  assert.match(r.message, /读取失败/)
})

test('车道表面包含 memory 与 loopStatus，既有动词不受影响', () => {
  const secretary = createAmooSecretary({ client: fakeClient(() => ({ success: true })), send: () => {} })
  for (const fn of ['probe', 'ask', 'result', 'stop', 'memory', 'loopStatus', 'release']) {
    assert.equal(typeof secretary[fn], 'function', `车道必须暴露 ${fn}`)
  }
})

// 渲染层契约（与 amooSecretaryUiContract.test.cjs 同型，这里只管记忆这几条）：
// 桌面写入恒记「未验证」、能力缺席整组禁用、只走 preload 通道。
// 记忆区已从 AmooSecretaryPane 拆到 AmooSecretaryMemory（metrics 闸门 B1），
// 断言不变，选择器改为对两份拼接文本跑。
test('渲染层：桌面写入恒带「未验证」，能力缺席时记忆区禁用并说明原因', () => {
  const pane = ['../src/renderer/components/amoon/AmooSecretaryPane.tsx', '../src/renderer/components/amoon/AmooSecretaryMemory.tsx']
    .map((rel) => fs.readFileSync(path.resolve(here, rel), 'utf8'))
    .join('\n')
  assert.match(pane, /const desktopWritten = entry\.provenance === DESKTOP_PROVENANCE/, '必须按 provenance 识别桌面写入')
  assert.match(pane, /const verified = !desktopWritten && entry\.confidence === 'verified'/, '桌面写入不因勾选而显示已核实')
  assert.match(pane, /amooSecretaryMemory/, '面板必须走 amooSecretaryMemory 通道')
  assert.match(pane, /这一组能力整组随 Amoo 安装态关闭/, '能力缺席的禁用文案照方案原文')
  assert.match(pane, /disabled=\{capability !== 'on' \|\| memView\.kind === 'reading'\}/, '读取按钮在能力缺席时禁用')
  // 上限单一真源（catalog 经 probe 回包下发）后，写入表单多了一个 !memoryLimits 档：
  // 上限没拿到同样不许写，与能力缺席同一行禁用。
  assert.match(pane, /capability !== 'on' \|\| !memoryLimits \|\| memView\.kind === 'writing'/, '写入表单在能力缺席/上限未达时禁用')
  // 桌面不另存、不缓存
  assert.doesNotMatch(pane, /localStorage|sessionStorage|indexedDB/, '桌面不得给共享记忆开第二份存储')
  assert.doesNotMatch(pane, /\bfetch\s*\(|readFileSync|node:fs/, '渲染层不得自己读磁盘或直连桥')
})

// stop 回包端到端的前半段在下面的车道两档用例里钉住；这里钉后半段：面板必须
// 绑定返回值并把 message 渲染出来——await 不接返回值，车道专门写的收尾提示
// 就在 AmooSecretaryPane 一行代码处丢失（底稿 A3）。两档文案与车道原文的
// 逐字一致性由 amooSecretaryUiContract.test.cjs 跨文件核对。
test('渲染层：stopAsk 绑定 stop 回包并渲染 message，收尾档中止按钮保持可用', () => {
  const pane = fs.readFileSync(path.resolve(here, '../src/renderer/components/amoon/AmooSecretaryPane.tsx'), 'utf8')
  assert.match(pane, /const r = await a\.amooSecretaryStop\(\)/, 'stopAsk 必须绑定返回值（await 不接返回值就是把回包丢在半路）')
  assert.match(pane, /仍在收尾/, '面板必须能从 message 识别收尾档（车道不向面板回传 ask_running）')
  assert.match(pane, /<StopNoticeBlock notice=\{stopNotice\} \/>/, 'stop 回包必须喂进渲染块')
  assert.match(pane, /\{notice\.message\}/, 'stop 回包的 message 必须被渲染出来')
  assert.match(pane, /stopNotice\?\.wrappingUp === true/, '收尾档必须让中止按钮保持可点（可再点一次正是这句的意义）')
  assert.match(
    pane,
    /lane\.state === 'stopped' && stopNotice \?[\s\S]{0,120}?<StopNoticeBlock/,
    '收尾档渲染 stop 回包原文，不得画成「已中止」的完成块'
  )
})

// ── 问答核心（提问 / 轮询 / 中止）───────────────────────────────────────────
// 上面管记忆动词，下面管这条链上真正出过的事：confirm 漏传、四种失败码混成
// 一桶、事件寻错址（提问有反应而进度条永远停在第 0 轮）、预算耗尽伪装成功、
// 空态被渲染成失败、卸载后轮询不停、token 漏进回包。

const CORE_TOKEN = 'khy_' + 't'.repeat(43)

// 手动定时器：轮询节奏由测试推进，不赌真实时钟，也不留悬空 timer。
function coreTimer() {
  let queue = []
  return {
    setTimer: (fn) => {
      const handle = { fn }
      queue.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      queue = queue.filter((h) => h !== handle)
    },
    pending: () => queue.length,
    tick: () => {
      const due = queue
      queue = []
      for (const h of due) h.fn()
    },
  }
}

// 假 client 是同步 async，pollOnce 的 await 链有几层就抽几层微任务。
const drain = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}

// 每次读表都在走的时钟：预算耗尽测试用它把「已等」推过上限。
function walkClock(start, step) {
  let t = start
  return () => {
    t += step
    return t
  }
}

function coreClient() {
  const calls = []
  const state = {
    probeResult: { ok: true, assistantAvailable: true, relayWithheld: [], uiAvailable: true },
    askResult: { success: true, channel: 'http', job: 'ask-1', state: 'running', timeout_ms: 420000 },
    resultResult: { success: true, channel: 'http', state: 'running', ms: 1000 },
    stopResult: { success: true, channel: 'http', ask_running: false, running: false },
  }
  const client = {
    probe: async () => state.probeResult,
    call: async (tool, args, options) => {
      calls.push({ tool, args: { ...(args || {}) }, options })
      if (tool === 'amoo_ask') return state.askResult
      if (tool === 'amoo_result') return state.resultResult
      if (tool === 'amoo_stop') return state.stopResult
      return { success: true }
    },
  }
  return { client, calls, state }
}

function coreHarness(opts = {}) {
  const timer = coreTimer()
  const events = []
  const made = coreClient()
  const lane = createAmooSecretary({
    client: opts.client || made.client,
    send: (m) => events.push(m),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    // 这些用例不测台账：显式关掉，终态就不会写进真实数据家的 ledger.jsonl
    //（台账自身的契约在 amooSecretaryLedger.test.mjs，全部走 temp/null 注入）。
    ledger: null,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { lane, events, calls: made.calls, state: made.state, timer }
}

// 手机侧拒绝的形状照 phoneBridgeClient 的 _interpretBridgeBody：顶层 code 被
// 统一改写成 bridge_error，真码在嵌套的 result 里——分档必须读嵌套那一层。
function refusal(code, error) {
  return { success: false, channel: 'http', code: 'bridge_error', error, result: { ok: false, code, error } }
}

test('ask/stop 带 confirm:true；result 不带（漏 confirm 会让提问恒返 requires_confirm、中止恒无效）', async () => {
  const { lane, calls, timer } = coreHarness()
  await lane.ask({ prompt: '你好' })
  const askCall = calls.find((c) => c.tool === 'amoo_ask')
  assert.deepEqual(askCall.options, { confirm: true })
  assert.deepEqual(askCall.args, { prompt: '你好', timeout_ms: 420000 })

  await lane.stop()
  assert.deepEqual(calls.find((c) => c.tool === 'amoo_stop').options, { confirm: true })

  await lane.result()
  assert.equal(calls.find((c) => c.tool === 'amoo_result').options, undefined, 'amoo_result 是 ACCESS_READ，不需要确认')
  assert.equal(timer.pending(), 0)
})

test('四种失败码从 result.code 分档，文案互不相等，手机原话透传', async () => {
  const cases = [
    ['amoo_not_foreground', 'amoo 不在前台，提问没有发出。先打开 amoo 的聊天页再重试。'],
    ['orphaned_ask', 'orphaned_ask: 上一笔提问超过最大预算仍未结束'],
    ['refused', '无障碍服务未开启：请在手机设置里打开 KhyOS 无障碍服务'],
    ['single_flight', '已有一个反代任务在进行中，先用 amoo_result 取结果'],
  ]
  const messages = {}
  for (const [code, error] of cases) {
    const events = []
    const lane = createAmooSecretary({
      client: { probe: async () => ({ ok: true }), call: async () => refusal(code, error) },
      send: (m) => events.push(m),
      ...coreTimer(),
    })
    const r = await lane.ask({ prompt: 'hi' })
    assert.equal(r.ok, false, `${code} 必须是失败回复`)
    assert.equal(r.error.code, code)
    messages[code] = r.error.message
    assert.equal(events.length, 0, '提问被拒不得起轮询')
  }
  assert.equal(new Set(Object.values(messages)).size, 4, '四种失败码的文案必须互不相等')
  assert.match(messages.amoo_not_foreground, /Amoo 不在前台/)
  assert.match(messages.orphaned_ask, /上一笔提问超过最大预算仍未结束/, 'orphaned_ask 要透传手机原话')
  assert.match(messages.orphaned_ask, /可重试/)
  assert.match(messages.refused, /无障碍服务未开启/, 'refused 透传原话')
  assert.match(messages.single_flight, /已有一问在跑/)
})

test('提问后事件照样到达：ask RPC 早已返回，车道没有 pending 表可寻', async () => {
  // 专钉「提问有反应、进度条永远停在第 0 轮」：若照 main 的 pendingAi 流事件
  // 分支寻址，ask 返回时条目已删，之后每个事件都取到 undefined、一个字节都
  // 不送（该分支没有 else 兜底）。车道因此只推无主事件，由 main 广播。
  const { lane, events, timer, state } = coreHarness()
  const asked = await lane.ask({ prompt: '在吗' })
  assert.equal(asked.ok, true)
  assert.equal(typeof asked.askId, 'string')
  assert.equal(asked.unverified, true)
  assert.equal(timer.pending(), 1, 'ask 成功后车道应排上第一轮轮询')

  timer.tick()
  await drain()
  assert.equal(events.length, 1)
  assert.deepEqual(
    { type: events[0].type, phase: events[0].phase, round: events[0].round, jobId: events[0].jobId },
    { type: 'amooSecretary.event', phase: 'polling', round: 1, jobId: asked.askId },
  )
  assert.match(events[0].message, /等待 Amoo 回复 · 第 1 轮/)

  timer.tick()
  await drain()
  assert.equal(events[1].round, 2)
  assert.equal(timer.pending(), 1, '一轮推完要继续排下一轮')

  state.resultResult = { success: true, channel: 'http', state: 'done', reply: '在的，说吧', ms: 12345 }
  timer.tick()
  await drain()
  const done = events[events.length - 1]
  assert.equal(done.phase, 'done')
  assert.equal(done.reply, '在的，说吧')
  assert.equal(done.unverified, true)
  assert.equal(timer.pending(), 0, '终局后不再排轮')

  const r = await lane.result()
  assert.equal(r.state, 'done')
  assert.equal(r.reply, '在的，说吧')
  assert.equal(r.unverified, true)
})

test('预算耗尽推 budget_exhausted 并给「继续等/中止」，绝不推 done', async () => {
  const { lane, events, timer } = coreHarness({ now: walkClock(1_000_000, 6000) })
  await lane.ask({ prompt: '讲个长点的', timeoutMs: 15000 })
  for (let i = 0; i < 3; i += 1) {
    timer.tick()
    await drain()
  }
  const phases = events.map((e) => e.phase)
  assert.ok(phases.includes('polling'), '耗尽前应有正常轮次')
  assert.ok(phases.includes('budget_exhausted'))
  assert.ok(!phases.includes('done'), '预算耗尽不是成功')
  assert.ok(!phases.includes('failed'), '预算耗尽也不是失败：手机侧任务还活着')
  const exhausted = events.find((e) => e.phase === 'budget_exhausted')
  assert.match(exhausted.message, /继续等/)
  assert.match(exhausted.message, /中止/)
  assert.equal(timer.pending(), 0, '耗尽后停轮询')

  const r = await lane.result()
  assert.equal(r.state, 'budget_exhausted', '结果读取也必须保持耗尽态，不翻回进度')
  assert.equal(r.unverified, true)
})

test('state="" 是空态：不是 failed 也不是成功；轮询中桥转空则是 no_ask_running', async () => {
  const idle = coreHarness()
  idle.state.resultResult = { success: true, channel: 'http', state: '', ms: 0 }
  const r = await idle.lane.result()
  assert.equal(r.state, '')
  assert.equal(r.error, undefined)
  assert.equal(r.stopReason, undefined)

  const mid = coreHarness()
  await mid.lane.ask({ prompt: '在吗' })
  mid.state.resultResult = { success: true, channel: 'http', state: '', ms: 0 }
  mid.timer.tick()
  await drain()
  assert.equal(mid.events[mid.events.length - 1].phase, 'idle')
  const after = await mid.lane.result()
  assert.equal(after.state, 'no_ask_running')
})

test('取消即停轮询：release 后没有后续 send，也不再多拉一次手机', async () => {
  const { lane, events, calls, timer } = coreHarness()
  await lane.ask({ prompt: '在吗' })
  timer.tick()
  await drain()
  assert.ok(events.length >= 1)

  lane.release()
  assert.equal(timer.pending(), 0)
  const seenEvents = events.length
  const seenReads = calls.filter((c) => c.tool === 'amoo_result').length
  timer.tick()
  await drain(10)
  assert.equal(events.length, seenEvents, 'release 后不得再有事件推送')
  assert.equal(calls.filter((c) => c.tool === 'amoo_result').length, seenReads, 'release 后不得再读手机')
})

test('prompt 超长 / timeout 越界在本地被拒并带区间说明，不改用户输入、不发桥', async () => {
  const { lane, calls } = coreHarness()
  const long = await lane.ask({ prompt: 'x'.repeat(20001) })
  assert.equal(long.ok, false)
  assert.match(long.error.message, /20000/)

  const low = await lane.ask({ prompt: 'hi', timeoutMs: 5000 })
  assert.equal(low.ok, false)
  assert.match(low.error.message, /15000/)
  assert.match(low.error.message, /1800000/)

  assert.equal((await lane.ask({ prompt: 'hi', timeoutMs: 1800001 })).ok, false)
  assert.equal((await lane.ask({ prompt: '   ' })).ok, false)
  assert.equal(calls.length, 0, '预检拒绝不得惊动桥')
})

test('单飞归手机：本地已有 job 时第二次 ask 照样发出去，由手机判 single_flight', async () => {
  const { lane, calls, state, timer } = coreHarness()
  await lane.ask({ prompt: '第一问' })
  state.askResult = refusal('single_flight', '已有一个反代任务在进行中，先用 amoo_result 取结果')
  const second = await lane.ask({ prompt: '第二问' })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'single_flight')
  assert.equal(calls.filter((c) => c.tool === 'amoo_ask').length, 2, '桌面不预拦，手机才判单飞')
  assert.equal(timer.pending(), 1, '被拒的第二问不接管轮询，第一问的轮次继续')
})

test('中止：confirm 带上、车道停轮询、终局事件与结果都保持 stopped', async () => {
  const { lane, events, calls, timer } = coreHarness()
  await lane.ask({ prompt: '在吗' })
  timer.tick()
  await drain()
  const r = await lane.stop()
  assert.equal(r.ok, true)
  assert.equal(calls.find((c) => c.tool === 'amoo_stop').options.confirm, true)
  assert.equal(timer.pending(), 0)
  assert.equal(events[events.length - 1].phase, 'stopped')
  const after = await lane.result()
  assert.equal(after.state, 'stopped', '用户中止后不得被桥的 aborted 回显翻回 failed')
})

test('中止失败如实说不成功，且不假装停过', async () => {
  const { lane, events, timer, state } = coreHarness()
  await lane.ask({ prompt: '在吗' })
  state.stopResult = { success: false, code: 'http_call_failed', error: 'HTTP 请求失败' }
  const r = await lane.stop()
  assert.equal(r.ok, false)
  assert.match(r.error.message, /中止未被桥接受/)
  assert.equal(events.some((e) => e.phase === 'stopped'), false, '没停成不得推 stopped')
  assert.equal(timer.pending(), 1, '停失败则轮询继续：手机可能还会答')
})

// 底稿 A3：amoo_stop 同时回 running 与 ask_running（Tools.java:1789-1790）。
// 两档都是 ok:true——中止已送达就是送达；差别只在手机自报的提问是否还在收尾，
// 文案必须互异，收尾档明说「可再点一次中止」。夹具原先把 stop 回包钉死在
// ask_running:false（coreClient 默认值），收尾档此前零覆盖。
test('stop 回包两档都 ok:true 且文案互异：ask_running=false 报已停止、=true 报仍在收尾', async () => {
  const normal = coreHarness()
  await normal.lane.ask({ prompt: '在吗' })
  const n = await normal.lane.stop()
  assert.equal(n.ok, true)
  assert.equal(n.message, '已中止：手机侧这一问已停止（未产生的回复不会补送）')

  const wrapping = coreHarness()
  await wrapping.lane.ask({ prompt: '在吗' })
  wrapping.state.stopResult = { success: true, channel: 'http', ask_running: true, running: true }
  const w = await wrapping.lane.stop()
  assert.equal(w.ok, true, '中止已送达就是送达，不得把收尾档伪装成失败')
  assert.equal(w.message, '中止已送达，但手机侧自报提问仍在收尾：可再点一次中止')
  assert.notEqual(n.message, w.message, '两档文案必须互异')
})

test('assistantAvailable=null 判「未知」，false 才是未报到', async () => {
  const probeWith = (assistantAvailable) =>
    createAmooSecretary({
      client: { probe: async () => ({ ok: true, assistantAvailable, relayWithheld: [], uiAvailable: false }) },
      send: () => {},
    }).probe()
  const unknown = await probeWith(null)
  assert.equal(unknown.ok, true)
  assert.equal(unknown.assistantAvailable, null)
  assert.match(unknown.hint, /没报到不等于没有/)
  const off = await probeWith(false)
  assert.equal(off.assistantAvailable, false)
  assert.match(off.message, /未报到助手协同能力/)
  assert.equal((await probeWith(true)).assistantAvailable, true)
})

test('探测失败是 ok:false + 嵌套 error，不伪造在线', async () => {
  const lane = createAmooSecretary({
    client: { probe: async () => ({ ok: false, code: 'device_not_found', error: '未发现手机设备' }) },
    send: () => {},
  })
  const r = await lane.probe()
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'device_not_found')
  assert.equal(r.assistantAvailable, undefined)
})

test('host 重启后的恢复读取：只报手机侧耗时，不报本进程没见过的轮次', async () => {
  const { lane } = coreHarness()
  const r = await lane.result()
  // 假 client 的 amoo_result 默认 running/ms=1000，而本进程没有 job
  assert.equal(r.state, 'polling')
  assert.equal(r.waitedMs, 1000)
  assert.equal(r.round, undefined, '没有 job 就没有轮次可报')
  assert.equal(r.budgetMs, undefined)
})

test('token 不出现在任何回包（探测/提问/结果/中止/循环状态）', async () => {
  const { lane, timer } = coreHarness({
    client: {
      probe: async () => ({
        ok: true,
        assistantAvailable: true,
        relayWithheld: [],
        uiAvailable: true,
        token: CORE_TOKEN,
        tokenPersisted: true,
        status: { token: CORE_TOKEN, token_persisted: true },
      }),
      call: async (tool) => {
        if (tool === 'amoo_ask') return { success: true, job: 'ask-1', token: CORE_TOKEN }
        if (tool === 'amoo_result') return { success: true, state: 'done', reply: '在的', token: CORE_TOKEN }
        return { success: true, ask_running: false, token: CORE_TOKEN }
      },
    },
  })
  const replies = [
    await lane.probe(),
    await lane.ask({ prompt: 'hi' }),
    await lane.result(),
    await lane.stop(),
    await lane.loopStatus(),
  ]
  for (const reply of replies) {
    assert.ok(!JSON.stringify(reply).includes(CORE_TOKEN), '回包不得包含 token：' + JSON.stringify(reply).slice(0, 120))
  }
  assert.equal(timer.pending(), 0)
})

// ── loop_status（手机侧循环的只读呈现）──────────────────────────────────────
// 桥本地能力、ACCESS_READ：不带 confirm，与 amoo_result/amoo_memory 同档。
// 桌面只镜像手机自报，字段照手机线上形状（Tools.java 的键是 report，
// AmooLoop.lastReport() 挂在它下面）；任何失败都不许落成 running 的某个值，
// 也绝不进台账（台账只记问答轮）。

test('loopStatus 只读：工具名 loop_status、args 空对象、整个 options 不传（ACCESS_READ 不带 confirm）', async () => {
  const client = fakeClient(() => ({ success: true, running: false, mode: 'default', report: '' }))
  const r = await createAmooSecretary({ client, send: () => {} }).loopStatus()
  assert.equal(r.ok, true)
  assert.equal(client.calls.length, 1)
  const call = client.calls[0]
  assert.equal(call.tool, 'loop_status')
  assert.deepEqual(call.args, {})
  assert.equal(call.options, undefined)
})

test('loopStatus 成功回包逐字段透传 running/mode/report，unverified 钉 true', async () => {
  const client = fakeClient(() => ({ success: true, running: true, mode: 'bypass', report: '第 3 轮：执行 ls' }))
  const r = await createAmooSecretary({ client, send: () => {} }).loopStatus()
  assert.equal(r.ok, true)
  assert.equal(r.running, true)
  assert.equal(r.mode, 'bypass')
  assert.equal(r.report, '第 3 轮：执行 ls')
  assert.equal(r.unverified, true)
  assert.equal(r.reportTruncated, undefined)
})

test('loopStatus 桥截断进展文本时带 reportTruncated，不静默装完整', async () => {
  const client = fakeClient(() => ({ success: true, running: true, mode: 'plan', report: 'x'.repeat(1024), truncated: true }))
  const r = await createAmooSecretary({ client, send: () => {} }).loopStatus()
  assert.equal(r.ok, true)
  assert.equal(r.reportTruncated, true)
})

test('loopStatus 桥没报 running 字段时是 null 不是 false（未知不许渲染成未运行）', async () => {
  const client = fakeClient(() => ({ success: true, mode: 'default', report: '' }))
  const r = await createAmooSecretary({ client, send: () => {} }).loopStatus()
  assert.equal(r.ok, true)
  assert.equal(r.running, null)
})

test('loopStatus 失败：抛错与桥拒绝都 ok:false、无 running 字段、手机原话透传', async () => {
  const throwing = {
    probe: async () => ({ ok: true }),
    call: async () => {
      throw new Error('adb 不在 PATH')
    },
  }
  const r1 = await createAmooSecretary({ client: throwing, send: () => {} }).loopStatus()
  assert.equal(r1.ok, false)
  assert.equal(r1.running, undefined)
  assert.match(r1.error.message, /读取循环状态失败/)
  assert.match(r1.error.message, /adb 不在 PATH/)

  const refusing = fakeClient(() => refusal('refused', '无障碍服务未开启：请在手机设置里打开 KhyOS 无障碍服务'))
  const r2 = await createAmooSecretary({ client: refusing, send: () => {} }).loopStatus()
  assert.equal(r2.ok, false)
  assert.equal(r2.running, undefined)
  assert.match(r2.error.message, /无障碍服务未开启/)
})

test('loopStatus 不进台账：record 一次都不发生，台账只记问答轮', async () => {
  let recorded = 0
  const ledger = {
    record: () => {
      recorded += 1
    },
    slice: () => ({ total: 0, entries: [], persisted: false }),
    total: () => 0,
  }
  const client = fakeClient(() => ({ success: true, running: true, mode: 'bypass', report: '进展' }))
  const secretary = createAmooSecretary({ client, send: () => {}, ledger })
  await secretary.loopStatus()
  await secretary.loopStatus()
  assert.equal(recorded, 0, '循环状态是只读快照，不是问答轮')
  assert.equal(client.calls.length, 2)
})

// main 的广播分支没法在 node:test 里行为化（main/index.ts import electron），
// 照本仓既有做法（amooUiContract / desktopUiContract）用源码契约钉住寻址方式。
// 秘书接线（含它的无主事件广播与 pending 表）已整体抽到 ./amooSecretaryBridge，
// main/index.ts 只留挂钩——所以这两条契约对 main/index.ts + amooSecretaryBridge.ts
// 的拼接文本断言：搬到哪里都行，不变量一条不减。
test('main：amooSecretary.event 走无主广播并跳过已销毁窗口，不寻 pendingAi 表', () => {
  const mainSrc = fs.readFileSync(path.resolve(here, '../src/main/index.ts'), 'utf8')
  const wiringSrc =
    mainSrc + fs.readFileSync(path.resolve(here, '../src/main/amooSecretaryBridge.ts'), 'utf8')
  assert.match(
    wiringSrc,
    /AMOO_SECRETARY_EVENT_CHANNEL = 'amooSecretary:event'|'amooSecretary\.event': 'amooSecretary:event'/,
    'host 事件通道必须映射到渲染层冒号通道（登记表随接线所在文件）',
  )
  const at = wiringSrc.indexOf("msg.type === 'amooSecretary.event'")
  assert.ok(at > 0, 'main 必须有 amooSecretary.event 分支（在接线模块或 main 本体）')
  const branch = wiringSrc.slice(at, at + 700)
  assert.ok(branch.includes('BrowserWindow.getAllWindows()'), '无主事件必须广播到所有窗口')
  assert.ok(branch.includes('isDestroyed()'), '必须跳过已销毁窗口')
  assert.ok(!branch.includes('pendingAi'), '无主事件不许寻 pendingAi 表（那样一个字节都送不出去）')
})

test('preload 暴露面板要的七个入口，全部与 main 同名注册', () => {
  const preloadSrc =
    fs.readFileSync(path.resolve(here, '../src/preload/index.ts'), 'utf8') +
    fs.readFileSync(path.resolve(here, '../src/preload/amooSecretary.ts'), 'utf8')
  const mainSrc =
    fs.readFileSync(path.resolve(here, '../src/main/index.ts'), 'utf8') +
    fs.readFileSync(path.resolve(here, '../src/main/amooSecretaryBridge.ts'), 'utf8')
  for (const method of [
    'amooSecretaryStatus',
    'amooSecretaryAsk',
    'amooSecretaryResult',
    'amooSecretaryStop',
    'amooSecretaryStopPolling',
    'amooSecretaryLoopStatus',
    'onAmooSecretaryEvent',
  ]) {
    assert.ok(preloadSrc.includes(method), `preload 缺少 ${method}`)
  }
  for (const channel of ['amooSecretary:status', 'amooSecretary:ask', 'amooSecretary:result', 'amooSecretary:stop', 'amooSecretary:stopPolling', 'amooSecretary:loopStatus']) {
    assert.ok(preloadSrc.includes(`ipcRenderer.invoke('${channel}'`), `preload 缺少 ${channel}`)
    // 接线抽出后 main 侧以 installAmooSecretaryBridge(ipcMain, …) 注入，注册点
    // 的形参叫 ipc——两种写法都算同一注册，不许因改名漏检。
    assert.ok(new RegExp(`ipc(Main)?\\.handle\\('${channel}'`).test(mainSrc), `main 缺少 ${channel}`)
  }
  assert.ok(preloadSrc.includes("ipcRenderer.on('amooSecretary:event'"), 'preload 必须监听冒号通道')
})

// ── 错误形状归一（唯一持有者：main 出口的 amooSecretaryBridge）───────────────
// 三种 legacy 形状各钉一条：main 本地的两处扁平串（host 未启动 / RPC 超时，已
// 改在源头嵌套）、host 中继 catch-all 的扁平串、memory 动词的顶层 {code,message}。
// 归一前，扁平串在面板 errText 两头落空，基础设施错误被显示成通用
// 「桥拒绝了这次提问」——三种成因挤进一句话，正是这条不许发生的事。

const bridge = await import(pathToFileURL(path.resolve(here, '../src/main/amooSecretaryBridge.ts')).href)

test('main 本地扁平串改在源头嵌套：host 未启动 / RPC 超时各带 code+message', () => {
  const down = bridge.hostUnavailableReply()
  assert.equal(down.ok, false)
  assert.equal(typeof down.error, 'object', '回包必须是嵌套形状，不许再是扁平串')
  assert.match(down.error.message, /host 进程未启动/)
  assert.equal(down.error.code, 'host_unavailable')
  const timeout = bridge.secretaryTimeoutReply()
  assert.equal(timeout.ok, false)
  assert.equal(typeof timeout.error, 'object')
  assert.match(timeout.error.message, /超时/)
  assert.equal(timeout.error.code, 'rpc_timeout')
  assert.notEqual(down.error.message, timeout.error.message, '桌面侧问题与响应超时是两种成因，不许共用一句话')
})

test('归一：host 车道 catch-all 的扁平串 error 变嵌套，原文逐字保留', () => {
  const flat = {
    type: 'amooSecretary.result',
    id: 'x',
    op: 'ask',
    ok: false,
    error: 'Amoo 秘书车道失败：boom，请查看导出日志排查 host 状态',
  }
  const out = bridge.normalizeAmooReply(flat)
  assert.equal(out.ok, false)
  assert.equal(typeof out.error, 'object', '扁平串必须归一成嵌套形状')
  assert.equal(out.error.message, 'Amoo 秘书车道失败：boom，请查看导出日志排查 host 状态')
  assert.equal(out.error.code, 'unknown', '扁平串没带码，unknown 是诚实默认，不许编一个')
})

test('归一：memory 顶层 {code,message} 变嵌套，legacy 字段不再与 error 双写', () => {
  const out = bridge.normalizeAmooReply({
    type: 'amooSecretary.result',
    id: 'x',
    op: 'memory',
    ok: false,
    code: 'invalid_args',
    message: '写入需要 id（稳定键，同 id 覆盖）：请填写后重试',
  })
  assert.deepEqual(out.error, { code: 'invalid_args', message: '写入需要 id（稳定键，同 id 覆盖）：请填写后重试' })
  assert.equal('code' in out, false, '顶层 code 不许和嵌套 error 双写')
  assert.equal('message' in out, false, '顶层 message 不许和嵌套 error 双写')
})

test('归一：已是嵌套 / ok:true / result 动词的 state 回包原样通过，不被推成 ok:false 形状', () => {
  const nested = { ok: false, error: { code: 'single_flight', message: 'Amoo 正忙（已有一问在跑）：等结果或先中止' } }
  assert.deepEqual(bridge.normalizeAmooReply(nested), nested, '车道分好的档不许被改写')
  const okReply = { ok: true, message: '已中止：手机侧这一问已停止（未产生的回复不会补送）' }
  assert.deepEqual(bridge.normalizeAmooReply(okReply), okReply)
  // result 动词的回包以 state 为真源、没有 ok 字段——归一只认 ok:false；
  // 把 state 回包推进 ok 形状会丢掉 budget_exhausted / no_ask_running 的语义。
  const laneResult = { state: 'failed', unverified: true, error: { code: 'refused', message: '手机侧拒绝了这次提问' } }
  assert.deepEqual(bridge.normalizeAmooReply(laneResult), laneResult)
})

test('main：秘书接线落 amooSecretaryBridge，归一挂在 resolve 出口，秘书段不再生产扁平串 error', () => {
  // 归一唯一持有者随接线整体在 amooSecretaryBridge 模块（amooSecretaryRequest）。
  const bridgeSrc = fs.readFileSync(path.resolve(here, '../src/main/amooSecretaryBridge.ts'), 'utf8')
  const at = bridgeSrc.indexOf('const amooSecretaryRequest')
  assert.ok(at > 0, '归一持有者 amooSecretaryRequest 必须在 amooSecretaryBridge 模块')
  const section = bridgeSrc.slice(at)
  assert.match(section, /resolve\(normalizeAmooReply\(v\)\)/, 'resolve 出口必须过 amooSecretaryBridge 的归一')
  assert.match(section, /hostUnavailableReply\(\)/, 'host 未启动回包走嵌套构造器')
  assert.match(section, /secretaryTimeoutReply\(\)/, 'RPC 超时回包走嵌套构造器')
  assert.ok(!/error: '/.test(section), 'amooSecretaryRequest 不许再生产扁平串 error（那是 errText 读不到的形状）')
  // main 只留薄挂钩：安装一次 + host 消息委托；扁平串错误不再有任何产地。
  const mainSrc = fs.readFileSync(path.resolve(here, '../src/main/index.ts'), 'utf8')
  assert.match(mainSrc, /installAmooSecretaryBridge\(ipcMain/, 'main 必须安装秘书桥接模块')
  assert.match(mainSrc, /handleAmooSecretaryHostMessage\(m\)/, 'host 消息里秘书两族必须委托给桥接模块')
  // stop 的四个同病调用点之一在 preload：ok:false 时它读嵌套 error.message 抛出，
  // 归一后它拿到的恒是具体原因，不再是兜底的「中止未被桥接受」。
  // preload 的秘书 API 也抽到了 src/preload/amooSecretary.ts：stop 的消费断言读两份拼接。
  const preloadSrc =
    fs.readFileSync(path.resolve(here, '../src/preload/index.ts'), 'utf8') +
    fs.readFileSync(path.resolve(here, '../src/preload/amooSecretary.ts'), 'utf8')
  assert.match(preloadSrc, /r\.error\?\.message \|\| '中止未被桥接受'/, 'preload 的 stop 失败必须读嵌套 error.message')
})

// ── 读取失败分档（read_failed ≠ failed）────────────────────────────────────
// 车道以 state 机器分档：桥明说这一问失败才是 failed；这轮根本读不到手机状态
// 是 read_failed。两者曾经共用 failed + 同一标题，手机离线时同屏说谎。

test('读取失败是 read_failed 不是 failed：连接问题不冒充桥报了失败', async () => {
  const client = {
    probe: async () => ({ ok: true }),
    call: async () => {
      throw new Error('adb 不在 PATH')
    },
  }
  const lane = createAmooSecretary({ client, send: () => {}, ledger: null })
  const r = await lane.result()
  assert.equal(r.state, 'read_failed')
  assert.notEqual(r.state, 'failed')
  assert.match(r.error.message, /读取 Amoo 提问状态失败/)
  assert.match(r.error.message, /adb 不在 PATH/)
  assert.equal(r.unverified, true)
})

test('桥对 result 回 success:false 同样是 read_failed，桥的原话进文案与 stopReason', async () => {
  const lane = createAmooSecretary({
    client: {
      probe: async () => ({ ok: true }),
      call: async () => refusal('refused', '无障碍服务未开启：请在手机设置里打开 KhyOS 无障碍服务'),
    },
    send: () => {},
    ledger: null,
  })
  const r = await lane.result()
  assert.equal(r.state, 'read_failed')
  assert.match(r.error.message, /读取 Amoo 提问状态失败/)
  assert.match(r.error.message, /无障碍服务未开启/, '桥的原话要进文案')
  assert.match(r.stopReason, /无障碍服务未开启/)
})

test('桥明说 state:"failed" 才是 failed：读取分档不吞真失败', async () => {
  const lane = createAmooSecretary({
    client: {
      probe: async () => ({ ok: true }),
      call: async () => ({ success: true, channel: 'http', state: 'failed', error: 'amoo_not_foreground', ms: 9000 }),
    },
    send: () => {},
    ledger: null,
  })
  const r = await lane.result()
  assert.equal(r.state, 'failed', '只有桥自己报 failed 才进 failed 档')
  assert.match(r.error.message, /Amoo 不在前台/)
})

test('read_failed 不是终局：不入台账（ledger.record 一次都不叫）', async () => {
  const recorded = []
  const ledger = {
    record: (entry) => recorded.push(entry),
    slice: () => ({ total: 0, entries: [], persisted: false }),
  }
  const lane = createAmooSecretary({
    client: {
      probe: async () => ({ ok: true }),
      call: async () => {
        throw new Error('adb 不在 PATH')
      },
    },
    send: () => {},
    ledger,
  })
  const r = await lane.result()
  assert.equal(r.state, 'read_failed')
  assert.equal(recorded.length, 0, '读不到状态不是一轮问答的结局，入账会伪造没发生的一轮')
})

// ── 回执抬头（报告 §四 P2-6）────────────────────────────────────────────────
// 这一轮问答所走能力的名字只有一个真源：Move 1 的工具契约（纯数据投影）。桌面
// 借它的 displayName 与手机端说同一个词；契约读不到就退回 wire 名——那是事实，
// 编一个显示名才是谎。回执同时要带轮次：面板渲染的是「哪一轮的哪次提问」。
const CONTRACT_FILE = path.resolve(
  here,
  '../../../runtime/node/backend/src/services/domain/network/amoo/amooToolContract.json',
)

function contractEntry(wireName) {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8'))
  const entry = (contract.tools || []).find((t) => t.wireName === wireName)
  assert.ok(entry, `夹具前提：契约里必须有 ${wireName} 条目`)
  return entry
}

// 车道的一次 done 轮：假 client 在 amoo_result 上回 done。
function doneRoundLane(ledger) {
  const timer = coreTimer()
  const state = {
    resultResult: { success: true, channel: 'http', state: 'done', reply: '在的，说吧', ms: 12345 },
  }
  const client = {
    probe: async () => ({ ok: true, assistantAvailable: true }),
    call: async (tool) => {
      if (tool === 'amoo_ask') return { success: true, channel: 'http', job: 'ask-1', state: 'running' }
      if (tool === 'amoo_result') return state.resultResult
      return { success: true }
    },
  }
  const events = []
  const lane = createAmooSecretary({
    client,
    send: (m) => events.push(m),
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ledger: ledger === undefined ? null : ledger,
  })
  return { lane, events, state, timer }
}

test('done 回包带契约 displayName 与轮次：两者都不是面板自己编的', async () => {
  await withRepoRoot(async () => {
    const entry = contractEntry('amoo_ask')
    const { lane, events, state, timer } = doneRoundLane()
    await lane.ask({ prompt: '在吗' })
    timer.tick()
    await drain()
    const r = await lane.result()
    assert.equal(r.state, 'done')
    assert.equal(r.displayName, entry.displayName, 'displayName 必须逐字取自工具契约')
    assert.equal(r.round, 1, 'done 回包必须带这一轮的轮次')
    assert.equal(r.unverified, true, '回执恒为未验证')
    const done = events[events.length - 1]
    assert.equal(done.displayName, entry.displayName, '事件带的是同一个契约名')
    assert.equal(done.round, 1)
  })
})

test('契约读不到时 displayName 退回 wire 名本身，不编一个显示名', async () => {
  const prev = process.env.KHY_OS_DIR
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'amoo-no-contract-'))
  process.env.KHY_OS_DIR = empty
  try {
    const { lane, timer } = doneRoundLane()
    await lane.ask({ prompt: '在吗' })
    timer.tick()
    await drain()
    const r = await lane.result()
    assert.equal(r.displayName, 'amoo_ask', '契约缺席时退回 wire 名：那是事实，显示名不是')
  } finally {
    if (prev === undefined) delete process.env.KHY_OS_DIR
    else process.env.KHY_OS_DIR = prev
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test('入账时带上同一个契约 displayName：台账条目与回包说的是同一个词', async () => {
  await withRepoRoot(async () => {
    const entry = contractEntry('amoo_ask')
    const recorded = []
    const ledger = {
      record: (e) => recorded.push(e),
      slice: () => ({ total: 0, entries: [], persisted: false }),
      total: () => 0,
    }
    const { lane, timer } = doneRoundLane(ledger)
    await lane.ask({ prompt: '在吗' })
    timer.tick()
    await drain()
    assert.equal(recorded.length, 1, '终态入账一次')
    assert.equal(recorded[0].displayName, entry.displayName, '台账条目带契约 displayName')
    assert.equal(recorded[0].rounds, 1, '台账条目带轮次')
    assert.equal(recorded[0].unverified, undefined, 'unverified 由台账强制，这里不代劳')
  })
})
