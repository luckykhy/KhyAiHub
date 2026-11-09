// amoo 秘书问答台账的运行时契约：环形淘汰、JSONL 往返、终态逐字、unverified
// 字面量、条目无 token、probe/result 回包携带历史切片、落点登记与 DATA-LOCATIONS
// 一致。台账唯一持有者在 host 进程（src/host/amooSecretaryLedger.ts），这里
// 一律显式注入 file（temp 目录 / null），绝不写真实数据家。
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const laneMod = await import(pathToFileURL(path.resolve(here, '../src/host/amooSecretary.ts')).href)
const ledgerMod = await import(pathToFileURL(path.resolve(here, '../src/host/amooSecretaryLedger.ts')).href)
const { createAmooSecretary } = laneMod
const { createAmooSecretaryLedger, LEDGER_RELATIVE_SEGMENTS } = ledgerMod

// 测试从 apps/khyos-desktop 跑：默认账本会解析到真实数据家，所以本文件所有
// 用例都显式给 file（temp / null）——真实落点只允许 host 进程在生产里写。
function tmpLedgerFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoo-ledger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'ledger.jsonl')
}

function rowOf(i) {
  return {
    askId: `amoo_${i}`,
    prompt: `问 ${i}`,
    startedAt: i * 10,
    endedAt: i * 10 + 5,
    durationMs: 5,
    rounds: 1,
    outcome: 'done',
    reply: `答 ${i}`,
  }
}

// ── 环形淘汰 ───────────────────────────────────────────────────────────────

test('环形 500 条：第 501 条进来时第 1 条出去，总数停在 500', () => {
  let n = 0
  const ledger = createAmooSecretaryLedger({ file: null, now: () => ++n })
  for (let i = 1; i <= 501; i += 1) ledger.record(rowOf(i))
  assert.equal(ledger.total(), 500)
  const slice = ledger.slice(500)
  assert.equal(slice.total, 500)
  assert.equal(slice.entries[0].prompt, '问 501', '最新在最前（新→旧）')
  assert.equal(slice.entries[499].prompt, '问 2', '最旧被淘汰后轮到问 2 垫底')
  assert.ok(!slice.entries.some((e) => e.prompt === '问 1'), '第 1 条必须出去')
})

test('slice 缺省只给最近 20 条，total 仍是环形里的全部', () => {
  let n = 0
  const ledger = createAmooSecretaryLedger({ file: null, now: () => ++n })
  for (let i = 1; i <= 30; i += 1) ledger.record(rowOf(i))
  const slice = ledger.slice()
  assert.equal(slice.total, 30)
  assert.equal(slice.entries.length, 20)
  assert.equal(slice.entries[0].prompt, '问 30')
  assert.equal(slice.entries[19].prompt, '问 11')
})

// ── JSONL 往返 ─────────────────────────────────────────────────────────────

test('JSONL 往返：新实例读同一文件，历史仍在、顺序新→旧', (t) => {
  const file = tmpLedgerFile(t)
  let n = 100
  const first = createAmooSecretaryLedger({ file, now: () => ++n })
  first.record({ askId: 'a_1', prompt: '第一问', startedAt: 1, endedAt: 2, durationMs: 1, rounds: 2, outcome: 'done', reply: '第一答' })
  first.record({ askId: 'a_2', prompt: '第二问', startedAt: 3, endedAt: 9, durationMs: 6, rounds: 1, outcome: 'budget_exhausted' })
  const second = createAmooSecretaryLedger({ file, now: () => 9999 })
  assert.equal(second.total(), 2)
  const slice = second.slice(10)
  assert.equal(slice.persisted, true)
  assert.equal(slice.entries[0].askId, 'a_2', '新→旧')
  assert.equal(slice.entries[0].outcome, 'budget_exhausted')
  assert.equal(slice.entries[1].prompt, '第一问')
  assert.equal(slice.entries[1].outcome, 'done')
  assert.equal(slice.entries[1].rounds, 2)
  assert.equal(slice.entries[1].reply, '第一答')
  assert.equal(slice.entries[1].unverified, true)
})

test('JSONL 里的残行（进程被杀写了一半）跳过不致命，后续追加自动补换行且不改既有字节', (t) => {
  const file = tmpLedgerFile(t)
  const ledger = createAmooSecretaryLedger({ file, now: () => 1 })
  ledger.record(rowOf(1))
  fs.appendFileSync(file, '{"askId":"torn","prompt":"被杀进程写了一半', 'utf8')
  const reopened = createAmooSecretaryLedger({ file, now: () => 2 })
  assert.equal(reopened.total(), 1, '残行不进台账')
  const before = fs.readFileSync(file, 'utf8')
  reopened.record(rowOf(2))
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(after.startsWith(before), '只追加：既有字节一个不动')
  const parsed = after.trimEnd().split('\n').slice(-1)[0]
  assert.equal(JSON.parse(parsed).askId, 'amoo_2', '补了换行后新行完整可解析')
})

// ── 终态逐字（经真实车道驱动）──────────────────────────────────────────────

function manualTimer() {
  let queue = []
  return {
    setTimer: (fn) => {
      const h = { fn }
      queue.push(h)
      return h
    },
    clearTimer: (h) => {
      queue = queue.filter((x) => x !== h)
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

function laneWith(ledger, opts = {}) {
  const state = {
    askResult: { success: true, state: 'running' },
    resultResult: { success: true, state: 'running', ms: 1000 },
    stopResult: { success: true, ask_running: false },
  }
  const client = {
    probe: async () => ({ ok: true, assistantAvailable: true }),
    call: async (tool) => {
      if (tool === 'amoo_ask') return state.askResult
      if (tool === 'amoo_result') return state.resultResult
      if (tool === 'amoo_stop') return state.stopResult
      return { success: true }
    },
  }
  const timer = manualTimer()
  const lane = createAmooSecretary({
    client,
    send: () => {},
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    ledger,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { lane, state, timer }
}

test('终态逐字：done 记 outcome=done，问题与回复原文入账，unverified 钉字面量 true', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const { lane, state, timer } = laneWith(ledger)
  await lane.ask({ prompt: '帮我看下这一轮' })
  state.resultResult = { success: true, state: 'done', reply: '这是手机气泡原文', ms: 12345 }
  timer.tick()
  await drain()
  const slice = ledger.slice(5)
  assert.equal(slice.total, 1)
  const e = slice.entries[0]
  assert.equal(e.outcome, 'done')
  assert.equal(e.prompt, '帮我看下这一轮')
  assert.equal(e.reply, '这是手机气泡原文')
  assert.equal(e.unverified, true, 'Amoo 内容恒带未验证，字面量 true')
  assert.equal(e.rounds, 1)
  assert.equal(typeof e.durationMs, 'number')
  assert.ok(e.durationMs >= 0)
})

test('终态逐字：预算耗尽记 budget_exhausted，绝不记成 done 或 failed', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  let clock = 1_000_000
  const { lane, timer } = laneWith(ledger, { now: () => (clock += 6000) })
  await lane.ask({ prompt: '讲个长点的', timeoutMs: 15000 })
  for (let i = 0; i < 3; i += 1) {
    timer.tick()
    await drain()
  }
  const slice = ledger.slice(5)
  assert.equal(slice.total, 1)
  assert.equal(slice.entries[0].outcome, 'budget_exhausted')
  assert.equal(slice.entries[0].reply, undefined, '没有回复就不得有 reply 字段')
  assert.equal(slice.entries[0].unverified, true)
})

test('终态逐字：用户中止记 stopped，停成之前不计账', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const { lane, state, timer } = laneWith(ledger)
  await lane.ask({ prompt: '在吗' })
  timer.tick()
  await drain()
  await lane.stop()
  const slice = ledger.slice(5)
  assert.equal(slice.total, 1)
  assert.equal(slice.entries[0].outcome, 'stopped')
  assert.equal(slice.entries[0].rounds, 1)

  // 停失败：车道没到终态，台账不得多出一条
  const file2 = tmpLedgerFile(t)
  const ledger2 = createAmooSecretaryLedger({ file: file2, now: () => 1 })
  const h2 = laneWith(ledger2)
  await h2.lane.ask({ prompt: '在吗' })
  h2.state.stopResult = { success: false, code: 'http_call_failed', error: 'HTTP 请求失败' }
  await h2.lane.stop()
  assert.equal(ledger2.total(), 0, '没停成不得记账')
})

test('终态逐字：桥报 failed 记 failed + 手机侧原话 stopReason，绝不记成成功', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const { lane, state, timer } = laneWith(ledger)
  await lane.ask({ prompt: '在吗' })
  state.resultResult = {
    success: true,
    state: 'failed',
    error: '无障碍服务未开启：请在手机设置里打开 KhyOS 无障碍服务',
  }
  timer.tick()
  await drain()
  const slice = ledger.slice(5)
  assert.equal(slice.total, 1)
  assert.equal(slice.entries[0].outcome, 'failed')
  assert.equal(slice.entries[0].stopReason, '无障碍服务未开启：请在手机设置里打开 KhyOS 无障碍服务')
  assert.ok(slice.entries[0].outcome !== 'done')
})

test('终态逐字：桥转空态记 no_ask_running（手机进程重启），不是失败也不是成功', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const { lane, state, timer } = laneWith(ledger)
  await lane.ask({ prompt: '在吗' })
  state.resultResult = { success: true, state: '', ms: 0 }
  timer.tick()
  await drain()
  const slice = ledger.slice(5)
  assert.equal(slice.total, 1)
  assert.equal(slice.entries[0].outcome, 'no_ask_running')
  assert.equal(slice.entries[0].error, undefined)
})

test('被拒的提问（single_flight 等）不记账：没到终态就没有轮次', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const state = {
    askResult: {
      success: false,
      code: 'bridge_error',
      error: '已有一个反代任务在进行中',
      result: { ok: false, code: 'single_flight', error: '已有一个反代任务在进行中' },
    },
  }
  const lane = createAmooSecretary({
    client: { probe: async () => ({ ok: true }), call: async () => state.askResult },
    send: () => {},
    ledger,
  })
  const r = await lane.ask({ prompt: '插队' })
  assert.equal(r.ok, false)
  assert.equal(ledger.total(), 0, '提问没发出去，不产生问答轮次')
})

// ── 诚实性：unverified 字面量 / token 不入账 ───────────────────────────────

test('record 调用方想塞 unverified:false 也被强制覆盖为 true；磁盘行同样只带 unverified:true', (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  ledger.record({ ...rowOf(1), unverified: false })
  const slice = ledger.slice(10)
  assert.equal(slice.entries[0].unverified, true)
  const onDisk = fs.readFileSync(file, 'utf8')
  assert.ok(!onDisk.includes('"verified":true'), '磁盘上不许出现 verified:true 形状')
  for (const line of onDisk.trim().split('\n')) {
    assert.equal(JSON.parse(line).unverified, true)
  }
})

test('桥回包里的 token 不进台账：内存切片与磁盘 JSONL 都搜不到', async (t) => {
  const TOKEN = 'khy_' + 'z'.repeat(43)
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const { lane, state, timer } = laneWith(ledger)
  state.askResult = { success: true, state: 'running', token: TOKEN }
  state.resultResult = { success: true, state: 'done', reply: '答', token: TOKEN, status: { token: TOKEN } }
  await lane.ask({ prompt: '在吗' })
  timer.tick()
  await drain()
  assert.equal(ledger.total(), 1, '终态已入账，断言才有意义')
  const dump = JSON.stringify(ledger.slice(10)) + fs.readFileSync(file, 'utf8')
  assert.ok(!dump.includes(TOKEN), '台账条目只收录白名单字段，token 不得入账')
  assert.equal(ledger.slice(10).entries[0].reply, '答')
})

// ── 历史切片经 probe / result 回包携带 ─────────────────────────────────────

test('probe 回包携带历史切片；探测失败（Amoo 缺席）时历史照样带回（硬约束①）', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  ledger.record(rowOf(1))
  const ok = createAmooSecretary({
    client: { probe: async () => ({ ok: true, assistantAvailable: true }), call: async () => ({ success: true }) },
    send: () => {},
    ledger,
  })
  const r = await ok.probe()
  assert.equal(r.ok, true)
  assert.equal(r.history.total, 1)
  assert.equal(r.history.entries[0].prompt, '问 1')
  assert.equal(r.history.entries[0].unverified, true)

  const off = createAmooSecretary({
    client: { probe: async () => ({ ok: false, code: 'device_not_found', error: '未发现手机设备' }), call: async () => ({ success: true }) },
    send: () => {},
    ledger,
  })
  const r2 = await off.probe()
  assert.equal(r2.ok, false)
  assert.equal(r2.history.total, 1, 'Amoo 缺席也要能回看本地历史')
  assert.equal(r2.history.entries[0].askId, 'amoo_1')
})

test('result 回包也带历史切片：终态入账后面板不用新 IPC 就能刷新历史', async (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const { lane, state, timer } = laneWith(ledger)
  await lane.ask({ prompt: '历史一问' })
  state.resultResult = { success: true, state: 'done', reply: '历史答复', ms: 900 }
  timer.tick()
  await drain()
  const r = await lane.result()
  assert.equal(r.state, 'done')
  assert.equal(r.history.total, 1)
  assert.equal(r.history.entries[0].prompt, '历史一问')
  assert.equal(r.history.entries[0].outcome, 'done')
})

test('历史切片的回复摘录 ≤600 字并带 replyExcerpted 标记；台账原文与磁盘不截断', (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  const long = '长'.repeat(900)
  ledger.record({ ...rowOf(1), reply: long })
  const slice = ledger.slice(10)
  assert.equal(slice.entries[0].reply.length, 600)
  assert.equal(slice.entries[0].replyExcerpted, true)
  assert.ok(fs.readFileSync(file, 'utf8').includes(long), '磁盘上仍是全文')
})

test('落盘不可用（append 失败）时 ledger 不炸、persisted=false，不许谎称重启后仍在', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoo-ledger-bad-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ledger = createAmooSecretaryLedger({ file: dir, now: () => 1 })
  ledger.record(rowOf(1))
  const slice = ledger.slice(5)
  assert.equal(slice.total, 1, '内存环形照常工作')
  assert.equal(slice.persisted, false, '写不进去就必须承认')
})

test('无落盘（file=null）时 persisted=false：仅本次运行的内存记录要如实标注', () => {
  let n = 0
  const ledger = createAmooSecretaryLedger({ file: null, now: () => ++n })
  ledger.record(rowOf(1))
  assert.equal(ledger.slice(5).persisted, false)
})

// ── 落点与登记一致性（§F 数据落点纪律）─────────────────────────────────────

test('落点契约：相对段固定为 T1-domains/desktop/amoo-secretary/ledger.jsonl，与 DATA-LOCATIONS.json 登记一致', () => {
  assert.deepEqual(LEDGER_RELATIVE_SEGMENTS, ['T1-domains', 'desktop', 'amoo-secretary', 'ledger.jsonl'])
  const regPath = path.resolve(here, '..', '..', '..', 'docs', '10_规范', 'registry', 'DATA-LOCATIONS.json')
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
  const entry = (reg.seedEntries || []).find((e) => e.id === 'amoo-secretary-ledger')
  assert.ok(entry, 'DATA-LOCATIONS.json seedEntries 必须登记 amoo-secretary-ledger')
  assert.equal(entry.home, 'khy')
  assert.equal(entry.tier, 'T1-domains')
  assert.equal(entry.kind, 'file')
  assert.equal(entry.regenerable, false)
  assert.equal(entry.backup, 'none')
  assert.equal(entry.delete, 'recursive')
  assert.match(entry.note, /非 Amoo 侧真源/)
})

test('台账模块不手写数据家路径：落点必须经后端 dataHome.js 解析', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/host/amooSecretaryLedger.ts'), 'utf8')
  assert.match(src, /getProjectDataPath/, '必须走后端 getProjectDataPath')
  assert.ok(!/works['"],\s*['"]data/.test(src), '不许手写第二份 works/data 路径解析')
  assert.ok(!/['"`]\.khy(?:quant|os)?['"`]/.test(src), '不许硬拼 .khy/.khyos 段（L-3 绕表直拼）')
})

// ── 能力名随条目落盘（报告 §四 P2-6）───────────────────────────────────────
// displayName 是车道按工具契约记进来的：台账只搬运，不改名、不补名。期望值当场
// 从契约读，不抄死——契约改了这里跟着改。
test('displayName 随条目进出：内存切片与磁盘 JSONL 都是契约里那个词，unverified 仍钉 true', (t) => {
  const file = tmpLedgerFile(t)
  const contract = JSON.parse(
    fs.readFileSync(
      path.resolve(here, '../../../runtime/node/backend/src/services/domain/network/amoo/amooToolContract.json'),
      'utf8',
    ),
  )
  const entry = (contract.tools || []).find((tool) => tool.wireName === 'amoo_ask')
  assert.ok(entry, '夹具前提：契约里必须有 amoo_ask 条目')
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  ledger.record({ ...rowOf(1), displayName: entry.displayName })
  const slice = ledger.slice(10)
  assert.equal(slice.entries[0].displayName, entry.displayName, '切片带契约 displayName')
  assert.equal(slice.entries[0].unverified, true, '能力名不许把 unverified 洗掉')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8').trim())
  assert.equal(onDisk.displayName, entry.displayName, '磁盘行带契约 displayName')
  assert.equal(onDisk.unverified, true)
})

test('旧行没有 displayName 也不补：字段缺失是事实，不许回填一个', (t) => {
  const file = tmpLedgerFile(t)
  let n = 0
  const ledger = createAmooSecretaryLedger({ file, now: () => ++n })
  ledger.record(rowOf(1))
  const slice = ledger.slice(10)
  assert.equal(slice.entries[0].displayName, undefined, '没写过就没有，不许补名')
})
