// 选中态对账的回归契约：选项表来自本次实时采集，持久化 id 来自上一次运行。
// 两者命名空间可能不同（采集 `<adapter>/<model>` vs presets `<presetId>`），
// 也可能只是本次探测没返回。**任何** miss 都不得自动改选，更不得写回 settings。
import { test } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { reconcileModelSelection, resolveModelPins } = await import(
  pathToFileURL(path.resolve(here, '../src/renderer/utils/useModelCatalog.ts')).href
)

// 采集路径（host collectModelEntries 投影）：adapter 级 + 模型级。
const collected = [
  { id: 'claude/claude-opus-5::auto', label: 'Claude Opus 5.0', format: 'openai', adapter: 'claude', model: 'claude-opus-5::auto', channel: 'claude', channelKnown: true, fromUpstream: true },
  { id: 'api/api:agnes:agnes-2.0-flash', label: 'agnes-2.0-flash', format: 'openai', adapter: 'api', model: 'api:agnes:agnes-2.0-flash', channel: 'api', channelKnown: true, fromUpstream: true },
  { id: 'cli', label: 'CLI 工具桥接', format: 'openai', adapter: 'cli', model: '', channel: 'cli', channelKnown: true, fromUpstream: false },
]

// providerPresets 静态兜底：首项 openai（本机没配 key 时不可用）。
const presets = [
  { id: 'openai', label: 'OpenAI · gpt-5.4', format: 'openai', adapter: 'openai', model: '', channel: 'openai', channelKnown: true, fromUpstream: false },
  { id: 'agnes/agnes-3.0-flash', label: 'agnes-3.0-flash', format: 'openai', adapter: 'agnes', model: 'agnes-3.0-flash', channel: 'agnes', channelKnown: true, fromUpstream: false },
]

test('对账：精确命中 → known=true 且 id 不变', () => {
  assert.deepEqual(reconcileModelSelection('cli', collected), { id: 'cli', known: true })
})

test('对账：采集成功但持久化 id 不在 → 保留原 id，绝不落到 options[0]', () => {
  const stale = 'api/api:agnes:agnes-3.0-flash'
  const state = reconcileModelSelection(stale, collected)
  assert.equal(state.id, stale)
  assert.equal(state.known, false)
  assert.notEqual(state.id, collected[0].id)
})

test('对账：采集为空回退 presets（命名空间不同）→ 同样保留原 id', () => {
  const stale = 'cli'
  const state = reconcileModelSelection(stale, presets)
  assert.equal(state.id, stale)
  assert.equal(state.known, false)
  assert.notEqual(state.id, presets[0].id)
})

test('对账：presets 选中态遇到采集目录 → 保留，不横跳到采集首项', () => {
  const stale = 'openai'
  const state = reconcileModelSelection(stale, collected)
  assert.equal(state.id, stale)
  assert.equal(state.id === collected[0].id, false)
})

test('钉选：模型级选项同时钉通道与模型', () => {
  assert.deepEqual(resolveModelPins('api/api:agnes:agnes-2.0-flash', collected), {
    preferredAdapter: 'api',
    preferredModel: 'api:agnes:agnes-2.0-flash',
  })
})

test('钉选：provider 级选项只钉通道', () => {
  assert.deepEqual(resolveModelPins('cli', collected), { preferredAdapter: 'cli' })
})

test('钉选：已消失的模型 id 不得从字符串反推，什么都不钉', () => {
  assert.deepEqual(resolveModelPins('api/api:agnes:agnes-3.0-flash', collected), {})
})

test('钉选：模型级 id 的 provider 级条目还在时只钉通道', () => {
  const withProvider = [...collected, { id: 'api', label: 'API', format: 'openai', adapter: 'api', model: '', channel: 'api', channelKnown: true }]
  assert.deepEqual(resolveModelPins('api/api:agnes:agnes-3.0-flash', withProvider), { preferredAdapter: 'api' })
})

test('钉选：channelKnown=false 的静态目录条目不钉通道', () => {
  const unknown = [{ id: 'openrouter/x', label: 'x', format: 'openai', adapter: 'openrouter', model: 'x', channel: 'openrouter', channelKnown: false, fromUpstream: false }]
  assert.deepEqual(resolveModelPins('openrouter/x', unknown), { preferredModel: 'x' })
})

// ── Auto（自动选型）────────────────────────────────────────────────
// host 现在把采集叶的 result.auto 投影成一条 id='auto' 的选项；它的 model 必须
// 是空串（哨兵只在 adapter 上），否则网关会把 'auto' 当真实模型名发上游。
const autoOption = {
  id: 'auto',
  label: '★ Auto',
  format: 'openai',
  adapter: 'auto',
  model: '',
  channel: 'auto',
  channelKnown: true,
  group: 'Auto',
  fromUpstream: true,
}
const withAuto = [autoOption, ...collected]

test('Auto：持久化 id 在本次目录里 → known=true，且不被改选成采集首项', () => {
  assert.deepEqual(reconcileModelSelection('auto', withAuto), { id: 'auto', known: true })
  assert.notEqual(withAuto[1].id, 'auto')
})

test('Auto：采集为空回退 presets 时仍保留原 id（不横跳）', () => {
  const state = reconcileModelSelection('auto', presets)
  assert.equal(state.id, 'auto')
  assert.equal(state.known, false)
  assert.notEqual(state.id, presets[0].id)
})

test('Auto：只钉通道 auto，绝不带 preferredModel', () => {
  assert.deepEqual(resolveModelPins('auto', withAuto), { preferredAdapter: 'auto' })
})

test('Auto：即使选项表缺失，id=auto 本身仍按哨兵解释', () => {
  assert.deepEqual(resolveModelPins('auto', []), { preferredAdapter: 'auto' })
})
