// modelsStore.test.mjs — 受管模型列表（models.ts）行为测试（DESIGN-ARCH-091 §8b）。
//
// 这个文件的存在理由：models 功能此前**一条行为断言都没有** —— 已有的
// wiringRuntime.test.mjs（32 通道注册）与 keymapContract.test.mjs（Ctrl+Shift+M）
// 只验接线，不验行为；applyModelToApp 写 settings.json、probeManagedModel 的
// 状态分类、union 派生、三名拼接全在绿区之外。本文件补上。
//
// 覆盖（每条都对应一个已发生过的坑）：
//   ① union 派生   —— 手工卡 models=[] 而 defaultModel 非空（或反之）时，条目
//                      只从一侧派生会让这张卡在页面里完全不可见
//   ② add          —— 同 id 重复 + makeDefault 的语义、无默认时首个即成默认
//   ③ update       —— 改名 / 设默认 / 目标已存在 / CC 当前模型的 ccWarning
//   ④ remove       —— 删默认后回落 models[0]、ccWarning
//   ⑤ apply        —— proxy 写三名、direct 写裸 id、app 收窄、model 下限
//   ⑥ probe        —— ok/auth/rate/upstream/timeout 五分类 + 代理未运行
//   ⑦ catalog      —— 非 openai 协议 verified:false 透显、openai 拉目录
//   ⑧ proxy runtime schema 裂口 —— 网关写**扁平**结构，桌面读方原来只认**嵌套**，
//                      真实网关永远被判「未运行」（P0，models:apply 必崩）
//   ⑨ relay token  —— env PROXY_AUTH_TOKEN 优先（与网关 resolvePrimaryAuthToken 同序）
//   ⑩ poolKey      —— 旧 `cc-switch:<cardId>` 命名空间逐字映射；空/非法则拒绝
//                      应用而不是静默退回裸 id 掉进 builtin-family 级联
//   ⑪ cc 态        —— 读回 settings.json 实际写入的模型名，不按卡片默认猜
//   ⑫ agents:apply 老路径 —— claude-code 的 proxy 也写三名（S2 口径分叉无测试钉住）
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/modelsStore.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// ── 隔离 dataHome + 假 HOME/XDG（必须在 import 前钉死）──────────────────────
// 与 agentWriters.test.mjs 同一套理由：不钉的话 keyManager 的解析链会落到仓库
// 根的 .khy，审计文件写进仓库（B8 影子目录违规）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-models-'))
process.env.KHY_DATA_HOME = path.join(tmp, 'khy')
process.env.KHYOS_DESKTOP_REPO_ROOT = path.join(tmp, 'repo') // 空仓根 → backend 不可解析
process.env.HOME = path.join(tmp, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg')
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.OPENCODE_CONFIG
delete process.env.OPENCODE_CONFIG_DIR
delete process.env.KHY_ENV_FILE
// ⑨ 的默认态：没有 env 令牌（那条用例自己临时设，完了删掉）
delete process.env.PROXY_AUTH_TOKEN

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 临时目录遗留无害 */
  }
})

const ks = await import('../src/main/keyManager/keyStore.ts')
const aw = await import('../src/main/keyManager/agentWriters.ts')
const ps = await import('../src/main/keyManager/proxyStatus.ts')
const models = await import('../src/main/keyManager/models.ts')

// ── fixtures ────────────────────────────────────────────────────────────────

const RELAY = 'RELAY-SENTINEL-TOKEN'
const REAL_KEY = 'sk-REAL-PROVIDER-KEY'

/**
 * 代理运行时文件。**刻意用网关的真实写法（扁平结构）**，不是桌面端旧 fixture 的
 * 嵌套结构 —— proxyServer.js:330-345 的 writeRuntimeStatus 落盘的是
 * {pid,host,port,httpPort,httpsPort,httpsEnabled,httpsOnly,mode,startedAt,updatedAt}，
 * 没有 http/https 嵌套对象。用嵌套结构写 fixture 会把 ⑧ 那条 schema 裂口焊死
 * （测试全绿而真实链路上 applyProxyMode 连代理门都过不去）。
 */
function writeFlatRuntime(port = 31288) {
  const files = ps._proxyFiles()
  fs.mkdirSync(path.dirname(files.runtime), { recursive: true })
  fs.writeFileSync(
    files.runtime,
    JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port,
      httpPort: port,
      httpsPort: null,
      httpsEnabled: false,
      httpsOnly: false,
      mode: 'http-only',
      startedAt: Date.now(),
      updatedAt: Date.now()
    }),
    'utf-8'
  )
  fs.writeFileSync(files.auth, JSON.stringify({ authToken: RELAY }), 'utf-8')
}

function removeRuntime() {
  const files = ps._proxyFiles()
  fs.rmSync(files.runtime, { force: true })
  fs.rmSync(files.auth, { force: true })
}

/** 建一张 openai 线卡片 + 池里的 provider key；返回 cardId。 */
async function makeCard(name = 'Agnes', protocol = 'openai', extra = {}) {
  const key = await ks.addKey({ provider: 'agnes', key: REAL_KEY, endpoint: 'https://apihub.agnes-ai.com/v1' })
  const card = await ks.addCard({
    name,
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    keyId: key.keyId,
    protocol,
    defaultModel: 'agnes-2.5-flash',
    apps: ['claude-code'],
    ...extra
  })
  assert.ok(card.ok, card.error)
  return card.cardId
}

async function cardOf(cardId) {
  const doc = await ks.loadCcDoc()
  return doc.cards.find((c) => c.id === cardId)
}

function readCcSettings() {
  return JSON.parse(fs.readFileSync(aw.agentTargetPath('claude-code'), 'utf-8'))
}

/** 让 globalThis.fetch 同时应答 /health 探活与探针 POST。 */
const stubFetch = (handler) => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => handler(String(url), init)
  return () => {
    globalThis.fetch = original
  }
}

// 最小 Response 形态（node:test 里不需要真 Response）。
// 写法注意：脚本 check-code-standards.js 的 COMP-001-func 用**朴素花括号计数**
// （不区分字符串与注释），所以本文件里任何注释/字符串都不能出现落单的花括号 —
// 上一版注释里写了带括号的箭头函数形态，落单的左括号让深度永远回不到 0，
// 于是它把后面 500 行全算成这一个函数。括号内容改用文字描述。
const jsonRes = (status, body) => {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body
  }
}

// ⑫ 走**真的** agents:apply handler（而不是复刻 ipc.ts 的三行逻辑）：S2 给这条
// 老路径加了 routableModel，但没有任何测试钉住它，后续有人改 opts 默认值不会被发现。
const { registerKeyManagerIpc } = await import('../src/main/keyManager/ipc.ts')

function captureKeyManagerHandlers() {
  const handlers = new Map()
  const ipc = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  registerKeyManagerIpc(ipc)
  return handlers
}

// ── ① union 派生 ───────────────────────────────────────────────────────────

test('① union 派生：models=[] 而 defaultModel 非空的手工卡也看得见', async () => {
  const cardId = await makeCard('UnionA', 'openai', { models: [], defaultModel: 'gpt-4o-mini' })
  const r = await models.listManagedModels()
  const hit = r.models.find((m) => m.cardId === cardId)
  assert.ok(hit, 'defaultModel 非空但 models=[] 的卡必须派生出条目')
  assert.equal(hit.model, 'gpt-4o-mini')
  assert.equal(hit.isDefault, true)
})

test('① union 派生：models 有值而 defaultModel 为空时全部列出，无默认', async () => {
  const cardId = await makeCard('UnionB', 'openai', { models: ['m-a', 'm-b'], defaultModel: '' })
  // addCard 会把 defaultModel 归一成 models[0]（keyStore.ts:633），所以「有 models
  // 无默认」只能由手工写盘造出来 —— 这正是 cc_switch.json 没有 schema 校验时
  // 真实会出现的形状。
  const doc = await ks.loadCcDoc()
  const card = doc.cards.find((c) => c.id === cardId)
  card.defaultModel = ''
  await ks.saveCcDoc(doc)
  const r = await models.listManagedModels()
  const mine = r.models.filter((m) => m.cardId === cardId).map((m) => m.model)
  assert.deepEqual(mine.sort(), ['m-a', 'm-b'])
  assert.equal(r.models.filter((m) => m.cardId === cardId && m.isDefault).length, 0, 'defaultModel 为空 → 没有默认')
})

test('① union 派生：defaultModel 与 models 重叠只出现一次', async () => {
  const cardId = await makeCard('UnionC', 'openai', { models: ['dup', 'other'], defaultModel: 'dup' })
  const r = await models.listManagedModels()
  const mine = r.models.filter((m) => m.cardId === cardId)
  assert.equal(mine.length, 2, `重叠被去重，实得 ${mine.length}`)
})

// ── ② add ──────────────────────────────────────────────────────────────────

test('② add：新模型进卡片，无默认时自动成为默认', async () => {
  const cardId = await makeCard('AddA', 'openai', { models: [], defaultModel: '' })
  const r = await models.addManagedModel({ cardId, model: 'gpt-4o-mini' })
  assert.ok(r.ok, r.error)
  const card = await cardOf(cardId)
  assert.deepEqual(card.models, ['gpt-4o-mini'])
  assert.equal(card.defaultModel, 'gpt-4o-mini', '无默认的卡加入首个模型即成默认')
})

test('② add：同 id 重复且未勾设为默认 → 拒绝（不是静默覆盖）', async () => {
  const cardId = await makeCard('AddB', 'openai', { models: ['dup'], defaultModel: 'dup' })
  const r = await models.addManagedModel({ cardId, model: 'dup' })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /已存在同 id 模型/)
})

test('② add：同 id + makeDefault → 转成设默认，不报错', async () => {
  const cardId = await makeCard('AddC', 'openai', { models: ['a', 'b'], defaultModel: 'a' })
  const r = await models.addManagedModel({ cardId, model: 'b', makeDefault: true })
  assert.ok(r.ok, r.error)
  const card = await cardOf(cardId)
  assert.equal(card.defaultModel, 'b')
  assert.deepEqual(card.models, ['a', 'b'], '不得重复追加')
})

test('② add：空 model（去空白后）→ 拒绝', async () => {
  const cardId = await makeCard('AddD')
  const r = await models.addManagedModel({ cardId, model: '   ' })
  assert.equal(r.ok, false)
})

// ── ③ update ───────────────────────────────────────────────────────────────

test('③ update：改名同步更新 models[]，且默认指针跟着走', async () => {
  const cardId = await makeCard('UpdA', 'openai', { models: ['old', 'keep'], defaultModel: 'old' })
  const r = await models.updateManagedModel({ cardId, from: 'old', to: 'new' })
  assert.ok(r.ok, r.error)
  const card = await cardOf(cardId)
  assert.deepEqual(card.models, ['new', 'keep'])
  assert.equal(card.defaultModel, 'new', '原名是默认 → 改名后默认必须跟着走，否则指针悬空')
})

test('③ update：目标 id 已存在 → 拒绝', async () => {
  const cardId = await makeCard('UpdB', 'openai', { models: ['a', 'b'], defaultModel: 'a' })
  const r = await models.updateManagedModel({ cardId, from: 'a', to: 'b' })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /已存在/)
})

test('③ update：只勾「设为默认」不改名', async () => {
  const cardId = await makeCard('UpdC', 'openai', { models: ['a', 'b'], defaultModel: 'a' })
  const r = await models.updateManagedModel({ cardId, from: 'b', makeDefault: true })
  assert.ok(r.ok, r.error)
  assert.equal((await cardOf(cardId)).defaultModel, 'b')
})

test('③ update：改的正是 Claude Code 当前激活模型 → 回 ccWarning', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('UpdD', 'openai', { models: ['old'], defaultModel: 'old' })
  await models.applyModelToApp({ app: 'claude-code', cardId, model: 'old', mode: 'proxy' })
  const r = await models.updateManagedModel({ cardId, from: 'old', to: 'renamed' })
  assert.ok(r.ok, r.error)
  assert.ok(r.ccWarning, 'CC 正在用的模型被改名必须提醒（settings.json 里仍是旧名）')
  assert.match(r.ccWarning, /Claude Code 正在使用该模型/)
})

// ── ④ remove ───────────────────────────────────────────────────────────────

test('④ remove：删默认模型 → 回落剩余首个', async () => {
  const cardId = await makeCard('RmA', 'openai', { models: ['a', 'b'], defaultModel: 'a' })
  const r = await models.removeManagedModel({ cardId, model: 'a' })
  assert.ok(r.ok, r.error)
  assert.equal(r.defaultModelCleared, true)
  const card = await cardOf(cardId)
  assert.deepEqual(card.models, ['b'])
  assert.equal(card.defaultModel, 'b')
})

test('④ remove：删非默认 → 不动默认', async () => {
  const cardId = await makeCard('RmB', 'openai', { models: ['a', 'b'], defaultModel: 'a' })
  const r = await models.removeManagedModel({ cardId, model: 'b' })
  assert.ok(r.ok, r.error)
  assert.equal(r.defaultModelCleared, false)
  assert.equal((await cardOf(cardId)).defaultModel, 'a')
})

test('④ remove：删 CC 当前激活卡的默认模型 → 回 ccWarning', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('RmC', 'openai', { models: ['only'], defaultModel: 'only' })
  await models.applyModelToApp({ app: 'claude-code', cardId, model: 'only', mode: 'proxy' })
  const r = await models.removeManagedModel({ cardId, model: 'only' })
  assert.ok(r.ok, r.error)
  assert.ok(r.ccWarning, '断链必须让用户看见')
})

// ── ⑤ apply ────────────────────────────────────────────────────────────────

test('⑤ apply(proxy)：settings.json 写可路由三名 + relay 令牌，不落明文 key', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('ApP', 'openai', { models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' })
  const r = await models.applyModelToApp({ app: 'claude-code', cardId, model: 'gpt-4o-mini', mode: 'proxy' })
  assert.ok(r.ok, r.error)
  const env = readCcSettings().env
  assert.equal(env.ANTHROPIC_MODEL, 'api:agnes:gpt-4o-mini', 'proxy 必须写三名（裸 id 会掉进 builtin-family 级联）')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, RELAY)
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:31288')
  assert.ok(!JSON.stringify(env).includes(REAL_KEY), '真实 provider key 不得出现在 agent 配置里')
})

test('⑤ apply(direct)：anthropic 线卡片写裸 id（上游认得裸 id）', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('ApD', 'anthropic', { models: ['claude-sonnet-4-5'], defaultModel: 'claude-sonnet-4-5' })
  const r = await models.applyModelToApp({ app: 'claude-code', cardId, model: 'claude-sonnet-4-5', mode: 'direct' })
  assert.ok(r.ok, r.error)
  assert.equal(readCcSettings().env.ANTHROPIC_MODEL, 'claude-sonnet-4-5')
})

test('⑤ apply：app 收窄为 claude-code（opencode 的 khy/ 前缀串味坑不给进）', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('ApX', 'openai', { models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' })
  const r = await models.applyModelToApp({ app: 'opencode', cardId, model: 'gpt-4o-mini', mode: 'proxy' })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /只服务 Claude Code/)
})

test('⑤ apply：model 不属于卡片 → 拒绝（IPC 层下限，不许任意字符串进 settings.json）', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('ApN', 'openai', { models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' })
  const r = await models.applyModelToApp({ app: 'claude-code', cardId, model: '../../etc/passwd', mode: 'proxy' })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /不属于该卡片/)
})

test('⑤ apply：卡片不存在 → 拒绝', async () => {
  writeFlatRuntime()
  const r = await models.applyModelToApp({ app: 'claude-code', cardId: 'c_nope', model: 'x', mode: 'proxy' })
  assert.equal(r.ok, false)
  assert.match(r.error || '', /卡片不存在/)
})

// ── ⑥ probe ────────────────────────────────────────────────────────────────

test('⑥ probe：代理未运行 → 诚实错误，不发请求', async () => {
  removeRuntime()
  const cardId = await makeCard('PbDown', 'openai', { models: ['m'], defaultModel: 'm' })
  let called = 0
  const restore = stubFetch(() => {
    called++
    return Promise.reject(new Error('should not be called'))
  })
  try {
    const r = await models.probeManagedModel({ cardId, model: 'm' })
    assert.equal(r.ok, false)
    assert.match(r.error || '', /代理未运行/)
    assert.equal(called, 0, '代理没起来就不该发探测请求')
  } finally {
    restore()
  }
})

test('⑥ probe：2xx + text 块 → status ok 且带回样例', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('PbOk', 'openai', { models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' })
  const restore = stubFetch((url, init) => {
    if (url.endsWith('/health')) return Promise.resolve(jsonRes(200, { ok: true }))
    assert.match(url, /\/v1\/messages$/, '探测必须打 Claude Code 实际用的那个路径')
    assert.equal(init.headers.authorization, `Bearer ${RELAY}`)
    assert.match(JSON.parse(init.body).model, /^api:agnes:gpt-4o-mini$/, '探测也要发三名')
    return Promise.resolve(jsonRes(200, { content: [{ type: 'text', text: 'pong-样例文本' }] }))
  })
  try {
    const r = await models.probeManagedModel({ cardId, model: 'gpt-4o-mini' })
    assert.ok(r.ok, r.error)
    assert.equal(r.data.status, 'ok')
    assert.equal(r.data.sample, 'pong-样例文本')
  } finally {
    restore()
  }
})

test('⑥ probe：401/403 → auth；429 → rate；5xx → upstream', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('PbCls', 'openai', { models: ['m'], defaultModel: 'm' })
  const cases = [
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate'],
    [500, 'upstream'],
    [503, 'upstream']
  ]
  for (const [status, want] of cases) {
    const restore = stubFetch((url) =>
      url.endsWith('/health') ? Promise.resolve(jsonRes(200, {})) : Promise.resolve(jsonRes(status, {}))
    )
    try {
      const r = await models.probeManagedModel({ cardId, model: 'm' })
      assert.ok(r.ok, r.error)
      assert.equal(r.data.status, want, `${status} 应分类为 ${want}，实得 ${r.data.status}`)
    } finally {
      restore()
    }
  }
})

test('⑥ probe：AbortError → timeout（RUNTIME-003 的活动式超时分支）', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('PbTo', 'openai', { models: ['m'], defaultModel: 'm' })
  // 真等 10s（PROBE_TIMEOUT_MS）太慢，这里直接以 AbortError 形态注入，断言的是
  // **分类**这一半；AbortController+timer 的接线由下面的源码判据钉住。
  const restore = stubFetch((url) => {
    if (url.endsWith('/health')) return Promise.resolve(jsonRes(200, {}))
    const e = new Error('aborted')
    e.name = 'AbortError'
    return Promise.reject(e)
  })
  try {
    const r = await models.probeManagedModel({ cardId, model: 'm' })
    assert.ok(r.ok, r.error)
    assert.equal(r.data.status, 'timeout')
    assert.match(r.data.detail, /超时/)
  } finally {
    restore()
  }
})

test('⑥ probe：网络错误 → upstream，不伪装成 ok', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('PbNet', 'openai', { models: ['m'], defaultModel: 'm' })
  const restore = stubFetch((url) =>
    url.endsWith('/health') ? Promise.resolve(jsonRes(200, {})) : Promise.reject(new Error('ECONNREFUSED'))
  )
  try {
    const r = await models.probeManagedModel({ cardId, model: 'm' })
    assert.ok(r.ok, r.error)
    assert.equal(r.data.status, 'upstream')
    assert.match(r.data.detail, /网络连接失败/)
  } finally {
    restore()
  }
})

// ── ⑦ catalog ──────────────────────────────────────────────────────────────

test('⑦ catalog：非 openai 协议 → verified:false + 文案原样透显（不假装有目录）', async () => {
  const cardId = await makeCard('CatGem', 'gemini', { models: [], defaultModel: '' })
  const r = await models.catalogForCard({ cardId })
  assert.ok(r.ok, r.error)
  assert.equal(r.verified, false)
  assert.deepEqual(r.models, [])
  assert.match(r.error || '', /无公开模型目录/)
})

test('⑦ catalog：openai 协议拉目录（fetch 打 {base}/v1/models）', async () => {
  const cardId = await makeCard('CatOa', 'openai', { models: [], defaultModel: '' })
  let seen = ''
  const restore = stubFetch((url) => {
    seen = url
    return Promise.resolve(jsonRes(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }))
  })
  try {
    const r = await models.catalogForCard({ cardId })
    assert.ok(r.ok, r.error)
    assert.equal(r.verified, true)
    assert.deepEqual(r.models, ['gpt-4o-mini', 'gpt-4o'])
    assert.match(seen, /\/v1\/models$/)
  } finally {
    restore()
  }
})

test('⑦ catalog：端点挂死/不可达 → verified:false + 原因，不抛不假装有目录', async () => {
  const cardId = await makeCard('CatDead', 'openai', { models: [], defaultModel: '' })
  // AbortError 是 PROBE/fetch 超时落到 catch 的真实形态；catalog 没有可注入的
  // fetchImpl 参数（fetchModels 用全局 fetch + 默认 10s），所以走 globalThis.fetch
  // 打桩 —— 断言的是「挂了不崩、如实说不可达」这条可观测行为。
  const restore = stubFetch(() => {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'AbortError'
    return Promise.reject(e)
  })
  try {
    const r = await models.catalogForCard({ cardId })
    assert.ok(r.ok, 'catalog 失败也要走 ok 信封（页面靠 verified 分支展示）')
    assert.equal(r.verified, false)
    assert.deepEqual(r.models, [])
    assert.match(r.error || '', /端点不可达/)
  } finally {
    restore()
  }
})

test('⑦ catalog：401/403 → verified:false + 鉴权文案（不把「要 key」说成「没目录」）', async () => {
  const cardId = await makeCard('Cat401', 'openai', { models: [], defaultModel: '' })
  const restore = stubFetch(() => Promise.resolve(jsonRes(401, {})))
  try {
    const r = await models.catalogForCard({ cardId })
    assert.equal(r.verified, false)
    assert.match(r.error || '', /鉴权失败/)
  } finally {
    restore()
  }
})

// ── ⑧ proxy runtime schema 裂口（P0）────────────────────────────────────────

test('⑧ proxyStatus：网关真实写法（扁平 runtime）判为运行中', async () => {
  writeFlatRuntime()
  const rt = ps.readProxyRuntime()
  assert.equal(rt.running, true, '扁平结构的 runtime 必须认 —— 否则 models:apply(proxy) 永远失败')
  assert.equal(rt.endpoint, 'http://127.0.0.1:31288')
  assert.equal(rt.port, 31288)
})

test('⑧ proxyStatus：旧嵌套写法仍认（读侧兼容，不迁移已落盘文件）', () => {
  const files = ps._proxyFiles()
  fs.mkdirSync(path.dirname(files.runtime), { recursive: true })
  fs.writeFileSync(
    files.runtime,
    JSON.stringify({ http: { enabled: true, port: 31289, host: '127.0.0.1', url: 'http://127.0.0.1:31289' } }),
    'utf-8'
  )
  const rt = ps.readProxyRuntime()
  assert.equal(rt.running, true)
  assert.equal(rt.port, 31289)
})

test('⑧ proxyStatus：https-only 的扁平 runtime 取 https 端口', () => {
  const files = ps._proxyFiles()
  fs.mkdirSync(path.dirname(files.runtime), { recursive: true })
  fs.writeFileSync(
    files.runtime,
    JSON.stringify({ host: '127.0.0.1', port: 443, httpPort: null, httpsPort: 8443, httpsEnabled: true, httpsOnly: true, mode: 'https-only' }),
    'utf-8'
  )
  const rt = ps.readProxyRuntime()
  assert.equal(rt.running, true)
  assert.equal(rt.port, 8443)
  assert.equal(rt.endpoint, 'https://127.0.0.1:8443')
})

test('⑧ proxyStatus：没有 runtime 文件 → 未运行', () => {
  removeRuntime()
  const rt = ps.readProxyRuntime()
  assert.equal(rt.running, false)
  assert.equal(rt.port, null)
})

// ── ⑨ relay token env 优先 ────────────────────────────────────────────────

test('⑨ readProxyToken：env PROXY_AUTH_TOKEN 优先于持久化文件（与网关同序）', () => {
  writeFlatRuntime()
  process.env.PROXY_AUTH_TOKEN = 'ENV-RELAY-TOKEN'
  try {
    assert.equal(ps.readProxyToken(), 'ENV-RELAY-TOKEN', '只读文件会让 probe 稳定 401（文案还指向错误修复动作）')
  } finally {
    delete process.env.PROXY_AUTH_TOKEN
  }
  assert.equal(ps.readProxyToken(), RELAY, '删掉 env 后回落到文件')
})

// ── ⑩ poolKey 归一化与下限 ─────────────────────────────────────────────────

test('⑩ canonicalPoolProviderName：旧 cc-switch:<id> 逐字映射为 cc_switch_<id>', () => {
  assert.equal(ks.canonicalPoolProviderName('cc-switch:c_26bfbcf07b5d378d'), 'cc_switch_c_26bfbcf07b5d378d')
  // 大小写不敏感的前缀（后端同式 toLowerCase 后比较）
  assert.equal(ks.canonicalPoolProviderName('CC-SWITCH:c_1'), 'cc_switch_c_1')
  // 已合法 → 原样透传（不误伤 openai / deepseek / my-provider）
  assert.equal(ks.canonicalPoolProviderName('openai'), 'openai')
  assert.equal(ks.canonicalPoolProviderName('my-provider'), 'my-provider')
  // 非法形态 → 字符类外折叠为下划线（首尾下划线与后端同式被剥掉）
  assert.equal(ks.canonicalPoolProviderName('weird name!'), 'weird_name')
  assert.equal(ks.canonicalPoolProviderName(''), '')
})

test('⑩ resolvePoolKeyForCard：池扫命中旧命名空间时返回合法池名', async () => {
  // 直接把旧命名空间写进 api_keys.json（复刻本机真实数据的形状）
  const poolPath = ks.dataHomeFile('api_keys.json')
  fs.mkdirSync(path.dirname(poolPath), { recursive: true })
  const legacyProvider = 'cc-switch:c_legacy01'
  const legacyKey = 'sk-LEGACY-CARD-KEY'
  fs.writeFileSync(
    poolPath,
    JSON.stringify({ [legacyProvider]: [{ key: legacyKey, endpoint: 'https://up.example/v1', label: 'legacy' }] }),
    'utf-8'
  )
  const keyId = ks.keyIdFor(legacyProvider, legacyKey)
  const poolKey = await ks.resolvePoolKeyForCard({ keyId, name: 'whatever' })
  assert.equal(poolKey, 'cc_switch_c_legacy01', '原样返回 cc-switch:c_legacy01 会拼出解不出池的四段名')
  assert.match(poolKey, /^[a-z0-9_-]+$/)
})

test('⑩ apply：poolKey 为空（解不出池）→ 拒绝，不静默退回裸 id', async () => {
  writeFlatRuntime()
  // 前面的用例已经在同一进程里写过 ~/.claude/settings.json，先清掉才能断言
  // 「拒绝时不得写文件」
  fs.rmSync(aw.agentTargetPath('claude-code'), { force: true })
  // 卡片名是纯非 ASCII → poolKeySlug 出来是空串；且 keyId 指向不存在的池条目
  const key = await ks.addKey({ provider: 'agnes', key: REAL_KEY, endpoint: 'https://apihub.agnes-ai.com/v1' })
  const card = await ks.addCard({
    name: '你好',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    keyId: key.keyId,
    protocol: 'anthropic',
    defaultModel: 'claude-x',
    apps: ['claude-code']
  })
  assert.ok(card.ok, card.error)
  // 把池清空，让 keyId 扫不到 → 回退卡片名 slug → 纯非 ASCII → 空
  fs.writeFileSync(ks.dataHomeFile('api_keys.json'), JSON.stringify({}), 'utf-8')
  const r = await models.applyModelToApp({ app: 'claude-code', cardId: card.cardId, model: 'claude-x', mode: 'proxy' })
  assert.equal(r.ok, false, 'poolKey 为空必须拒绝')
  assert.match(r.error || '', /解不出该卡片的密钥池名/)
  assert.ok(!fs.existsSync(aw.agentTargetPath('claude-code')), '拒绝时不得写 settings.json')
})

test('⑩ probe：poolKey 为空同样拒绝（探测发个解不出池的名字是假信号）', async () => {
  writeFlatRuntime()
  const key = await ks.addKey({ provider: 'agnes', key: REAL_KEY, endpoint: 'https://apihub.agnes-ai.com/v1' })
  const card = await ks.addCard({
    name: '你好',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    keyId: key.keyId,
    protocol: 'anthropic',
    defaultModel: 'claude-x',
    apps: ['claude-code']
  })
  fs.writeFileSync(ks.dataHomeFile('api_keys.json'), JSON.stringify({}), 'utf-8')
  let probeCalls = 0
  const restore = stubFetch((url) => {
    // /health 是代理态探活，照跑；真正的探测 POST 一个都不该发生
    if (url.endsWith('/health')) return Promise.resolve(jsonRes(200, {}))
    probeCalls++
    return Promise.resolve(jsonRes(200, {}))
  })
  try {
    const r = await models.probeManagedModel({ cardId: card.cardId, model: 'claude-x' })
    assert.equal(r.ok, false)
    assert.match(r.error || '', /解不出该卡片的密钥池名/)
    assert.equal(probeCalls, 0, '不得发出探测请求')
  } finally {
    restore()
  }
})

// ── ⑪ cc 态读回实际写入值 ──────────────────────────────────────────────────

test('⑪ cc.model 读 settings.json 实际值，不按卡片默认猜', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('CcRead', 'openai', { models: ['a', 'b'], defaultModel: 'a' })
  await models.applyModelToApp({ app: 'claude-code', cardId, model: 'a', mode: 'proxy' })
  // 用户改了卡片默认但**没有重新应用**：文件里仍是 a，卡片默认已是 b
  await models.updateManagedModel({ cardId, from: 'a', to: 'b', makeDefault: true })
  const r = await models.listManagedModels()
  assert.equal(r.cc.model, 'api:agnes:a', '必须显示 Claude Code 实际在用的名字，而不是卡片默认')
  assert.equal(r.cc.mode, 'proxy')
  assert.equal(r.cc.cardName, 'CcRead')
})

test('⑪ cc 块在 mode 为 none 时有确定取值（不各自猜）', async () => {
  removeRuntime()
  // 前面的用例已经 apply 过（agentMode 记着 proxy），清掉才是真正的「从未激活」
  const doc = await ks.loadCcDoc()
  delete doc.agentMode
  await ks.saveCcDoc(doc)
  const r = await models.listManagedModels()
  assert.equal(r.cc.mode, 'none')
  assert.equal(r.cc.cardId, '')
  assert.equal(r.cc.cardName, '')
  assert.equal(r.cc.model, '')
  assert.equal(r.cc.routableName, '')
  assert.equal(r.cc.lastApplied, '')
})

// ── ⑫ agents:apply 老路径也写三名 ──────────────────────────────────────────

test('⑫ agents:apply(claude-code, proxy) 也写三名（S2 口径分叉需测试钉住）', async () => {
  writeFlatRuntime()
  fs.rmSync(aw.agentTargetPath('claude-code'), { force: true })
  const cardId = await makeCard('OldPath', 'openai', { models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' })
  const handlers = captureKeyManagerHandlers()
  const r = await handlers.get('agents:apply')({ sender: { id: 1 } }, { app: 'claude-code', cardId, mode: 'proxy' })
  assert.ok(r.ok, r.error)
  assert.equal(readCcSettings().env.ANTHROPIC_MODEL, 'api:agnes:gpt-4o-mini', 'T3 老路径与 models:apply 必须同口径')
})

test('⑫ agents:apply 不传 routableModel 的老调用仍写裸名（行为零变化）', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('NoOpts', 'openai', { models: ['bare-id'], defaultModel: 'bare-id' })
  const card = await cardOf(cardId)
  const r = await aw.applyProxyMode('claude-code', card, {})
  assert.ok(r.ok, r.error)
  assert.equal(readCcSettings().env.ANTHROPIC_MODEL, 'bare-id')
})

// ── 审计粒度 ───────────────────────────────────────────────────────────────

test('审计：五个模型动作各有独立 op（apply 与 update 分得开）', async () => {
  writeFlatRuntime()
  const cardId = await makeCard('AuditM', 'openai', { models: ['m1'], defaultModel: 'm1' })
  await models.addManagedModel({ cardId, model: 'm2' })
  await models.updateManagedModel({ cardId, from: 'm2', to: 'm3' })
  await models.applyModelToApp({ app: 'claude-code', cardId, model: 'm1', mode: 'proxy' })
  await models.removeManagedModel({ cardId, model: 'm3' })
  const text = fs.readFileSync(ks.auditFilePath(), 'utf-8')
  for (const op of ['model-add', 'model-update', 'model-apply', 'model-remove']) {
    assert.ok(text.includes(`"op":"${op}"`), `审计缺独立 op ${op}`)
  }
})
