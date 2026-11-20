'use strict';

// commandPageGroups.test.cjs — 设置页「命令」页分组渲染的真实 DOM 验证。
//
// 为什么挂真组件而不是复制逻辑：分组/过滤代码内联在 ListSettingsPage.tsx 里，不是
// 可提取的纯函数（「为测试重构生产代码」不在测试员权限内），而渲染层又没有快照测试
// 环境。仓内对这个处境的既有答案是 esbuild + jsdom 挂载点（先例：
// tests/toolExecutionPlacement.test.cjs、tests/agentbusPanel.test.cjs、
// tests/amooPanel.test.cjs、tests/webRemotePanel.test.cjs —— 均已登记进 package.json
// 的 test 脚本）。本文件照此成例挂真 ListSettingsPage + 假 __KHYOS__.agentList，
// 钉住只有挂载后才存在的行为：
//   D1 组头按 main 目录序、只渲染非空组、默认全折叠、组内计数之和 = 总条数（不丢行）、
//      行上出现而目录没有的键按出现序补后且 label 回落键名；点组头展开/收起。
//   D2 搜索是并集语义（组名命中带整组、name/desc 命中带单行）、命中组强制展开、
//      清空回归折叠、无匹配走既有空态卡。
//   D3 钩子/技能/子智能体/记忆四 kind 走原样平铺分支（分组门关）。
//   D4 kind='command' 但 groups 为空（cli() 加载失败的窄窗口）同样回落平铺。
//
// 手法照 agentbusPanel.test.cjs：esbuild 打包 tests/commandPageGroups.harness.tsx，
// jsdom 挂载；React 状态更新靠 setTimeout(0) tick 冲刷，不用 act。
//
// runner 纪律：node:test + assert/strict，绝不用裸 describe/test/expect。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')

const APP_DIR = path.resolve(__dirname, '..')

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khycmdgrp-ui-')), 'harness.cjs')
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'commandPageGroups.harness.tsx')],
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

const { mount, unmount, setList, calls } = require(bundlePath)

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
const root = () => document.getElementById('root')
const text = () => root().textContent || ''
// 组头 = 唯一带 aria-expanded 的 button（ItemCard 的 详情/删除、页头操作都没有它）
const headers = () => [...root().querySelectorAll('button[aria-expanded]')]
// 行卡按钮：ItemCard 的「详情/收起」一行一个，折叠的组体里不渲染
const cardButtons = () =>
  [...root().querySelectorAll('button')].filter((b) => /^(详情|收起)$/.test((b.textContent || '').trim()))
const click = async (el) => {
  assert.ok(el, '找不到要点击的控件')
  el.click()
  await flush()
}
const type = async (value) => {
  const input = root().querySelector('input[type="text"]')
  assert.ok(input, '应渲染搜索框')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await flush()
}
const headerTexts = () => headers().map((b) => (b.textContent || '').replace(/\s+/g, ''))

// Teardown is defensive on purpose（agentbusPanel.test.cjs 同款理由）：unmount 抛了
// 的话 dom.window.close() 永远跑不到，jsdom 的定时器会把进程留住。
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

// ── 夹具：组目录形状对齐 main 侧 slashCommandGroups() 的出口 ────────────────

const CATALOG = [
  { key: 'model', label: 'AI 模型' },
  { key: 'data', label: '数据管理' },
  { key: 'security', label: '安全' },
  { key: 'dev', label: '开发工具' },
  { key: 'workflow', label: '工作流' },
  { key: 'system', label: '系统' },
  { key: 'analysis', label: '分析' },
  { key: 'skill', label: '技能命令' },
  { key: 'claude-code', label: 'Claude Code 命令' },
  { key: 'plugin', label: '命令插件' },
  { key: 'other', label: '其它' },
]

function item(name, groupKey, description = '') {
  const base = {
    id: `id:${name}`,
    kind: 'command',
    name,
    description,
    content: '',
    enabled: true,
    source: 'khy',
    createdAt: 0,
    updatedAt: 0,
    readOnly: true,
    toggleable: false,
    deletable: false,
  }
  // groupKey 缺省的行 = 主进程没打上键的行，渲染层按 main 自己的兜底落 'other'
  return groupKey === undefined ? base : { ...base, groupKey }
}

// 9 条命令行覆盖：两组有成员、一组空（data）、一行无 groupKey、一行带目录外的键。
// 「安全」同时是 security 的组名与 dev 两行 desc 里的词 —— D2 的并集语义靠它。
const COMMAND_ITEMS = [
  item('/model', 'model'),
  item('/memory', 'model'),
  item('/apikey', 'security'),
  item('/cleandisk', 'dev', '安全清理磁盘'),
  item('/repo', 'dev', '安全发布'),
  item('/commit', 'skill'),
  item('/study', 'other'),
  item('/nokey'),
  item('/mystery', 'mystery'),
]

const COMMAND_PROPS = {
  kind: 'command',
  noun: '命令',
  description: '与终端同一批命令',
  contentLabel: '命令内容',
}

async function mountPage({ kind = 'command', items = COMMAND_ITEMS, groups = CATALOG } = {}) {
  unmount()
  calls.length = 0
  setList({ ok: true, items, groups })
  mount({ ...COMMAND_PROPS, kind })
  await flush()
}

// ── D1: 组头序 / 空组不渲染 / 默认全折叠 / 不丢行 ──────────────────────────

test('D1: 组头按目录序、空组不渲染、默认全折叠、组内计数之和 = 总条数', async () => {
  await mountPage()
  const heads = headers()
  assert.equal(heads.length, 6, '只渲染有成员的组（data/workflow/system/analysis/claude-code/plugin 空，不渲染）')
  assert.deepEqual(headerTexts(), ['AI模型2条', '安全1条', '开发工具2条', '技能命令1条', '其它2条', 'mystery1条'])
  // 目录外的键按出现序补后、label 回落键名本身（不编造中文名）
  assert.equal(heads[5].textContent.includes('mystery'), true)
  // 默认全折叠：一张行卡都看不见（PluginMarketplace defaultOpen 先例被 23 卡首屏打掉，
  // 方案改为全折叠 —— 首屏就是组图本身）
  assert.equal(cardButtons().length, 0, '默认全部折叠，不应渲染任何行卡')
  // 组内计数之和 = 总条数（分组不丢行的量化判据）；计数文案是「N 条」带一个空格
  const sum = heads.reduce((n, h) => n + Number(/(\d+)\s*条/.exec(h.textContent || '')[1]), 0)
  assert.equal(sum, COMMAND_ITEMS.length, '组内计数之和必须等于总条数')

  // 点组头展开该组，再点收起
  await click(heads[0])
  assert.equal(heads[0].getAttribute('aria-expanded'), 'true')
  assert.equal(cardButtons().length, 2, 'AI 模型组 2 张卡')
  assert.ok(text().includes('/model') && text().includes('/memory'))
  assert.ok(!text().includes('/apikey'), '别的组不因展开而出现')
  await click(heads[0])
  assert.equal(heads[0].getAttribute('aria-expanded'), 'false')
  assert.equal(cardButtons().length, 0)

  // 逐个展开全部组：每一行都渲染得出来（分组不丢行的逐条判据）
  for (const h of headers()) await click(h)
  for (const it of COMMAND_ITEMS) {
    assert.ok(text().includes(it.name), `${it.name} 必须出现在某个展开的组里`)
  }
})

// ── D2: 搜索并集语义 + 命中组强制展开 + 清空回归折叠 ───────────────────────

test('D2: 搜索是并集语义（组名带整组、desc 带单行），命中组强制展开，清空回归折叠', async () => {
  await mountPage()
  // 「安全」：security 组名命中（1 行）+ dev 两行 desc 命中（/cleandisk、/repo）
  await type('安全')
  assert.deepEqual(headerTexts(), ['安全匹配1条', '开发工具匹配2条'])
  assert.equal(cardButtons().length, 3, '命中组强制展开，不靠手点')
  for (const name of ['/apikey', '/cleandisk', '/repo']) assert.ok(text().includes(name), name)
  assert.ok(!text().includes('/model'), '未命中组整块不渲染')

  // 敲名字只命中该行，同样强制展开
  await type('/model')
  assert.deepEqual(headerTexts(), ['AI模型匹配1条'])
  assert.equal(cardButtons().length, 1)

  // 无匹配走既有空态卡（文案逐字节未动）
  await type('zzz-no-such')
  assert.equal(headers().length, 0)
  assert.equal(cardButtons().length, 0)
  assert.ok(text().includes('没有匹配搜索的命令'))

  // 清空回归全折叠（折叠是组件 state，不持久化）
  await type('')
  assert.equal(headers().length, 6)
  assert.equal(cardButtons().length, 0)
})

// ── D3: 四 kind 走平铺分支（分组门关）────────────────────────────────────

test('D3: 钩子/技能/子智能体/记忆四 kind 走原样平铺分支（无组头、行卡立即可见）', async () => {
  const hookItems = [
    { id: 'h1', kind: 'hook', name: 'PreToolUse', description: '工具前', content: '', enabled: true, source: 'user', createdAt: 0, updatedAt: 0 },
    { id: 'h2', kind: 'hook', name: 'PostToolUse', description: '工具后', content: '', enabled: true, source: 'user', createdAt: 0, updatedAt: 0 },
    { id: 'h3', kind: 'hook', name: 'SessionStart', description: '会话开始', content: '', enabled: false, source: 'user', createdAt: 0, updatedAt: 0 },
  ]
  await mountPage({ kind: 'hook', items: hookItems, groups: [] })
  assert.deepEqual(calls, ['hook'], 'agentList 按 kind 调用')
  assert.equal(headers().length, 0, '非 command kind 不渲染组头')
  assert.equal(cardButtons().length, 3, '平铺分支：行卡不经点击立即可见')
  for (const it of hookItems) assert.ok(text().includes(it.name), it.name)
})

// ── D4: command kind 但目录空（cli() 加载失败的窄窗口）→ 回落平铺 ──────────

test('D4: kind=command 但 groups 为空（cli() 拉不到的窄窗口）回落平铺，不出英文组名', async () => {
  await mountPage({ kind: 'command', items: COMMAND_ITEMS.slice(0, 2), groups: [] })
  assert.equal(headers().length, 0, '目录空 → 分组门不开')
  assert.equal(cardButtons().length, 2, '回落平铺，行卡立即可见')
  assert.ok(text().includes('/model') && text().includes('/memory'))
  // 不渲染把 groupKey 当组名用的壳（回落必须与今日逐字节一致）
  assert.ok(!text().includes('model组') && !text().includes('mystery'))
})

// ── D5: 组内单卡「详情」展开（grouped 分支独有的交互）─────────────────────

test('D5: 组内点「详情」展开该卡正文、再点收起；组头折叠后组内行卡整体消失', async () => {
  const items = [
    { ...item('/model', 'model'), content: '模型命令正文' },
    { ...item('/memory', 'model'), content: '记忆命令正文' },
  ]
  await mountPage({ items, groups: CATALOG })
  assert.equal(headers().length, 1, '只有 model 组有成员')
  assert.equal(cardButtons().length, 0, '默认全折叠：组内一张行卡都不渲染')

  await click(headers()[0])
  assert.equal(cardButtons().length, 2, 'AI 模型组 2 张卡')
  // D1 只点了组头、数了卡片；组内单卡展开是 grouped 分支独有的第二层交互，
  // 回归发生在这里必须红。
  await click(cardButtons()[0])
  assert.equal(cardButtons()[0].textContent.trim(), '收起')
  assert.ok(text().includes('模型命令正文'), '组内单卡展开应显示正文')
  assert.ok(!text().includes('记忆命令正文'), '另一张卡不受影响')
  await click(cardButtons()[0])
  assert.ok(!text().includes('模型命令正文'), '再点收起，正文消失')

  // 组头折叠 → 组内行卡整体消失（单卡展开态不泄漏到折叠后）
  await click(headers()[0])
  assert.equal(cardButtons().length, 0)
})
