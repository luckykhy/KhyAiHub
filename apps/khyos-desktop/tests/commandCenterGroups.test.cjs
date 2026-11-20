'use strict';

// commandCenterGroups.test.cjs — Ctrl+K 面板（CommandCenter）khy 命令分组的真实 DOM 验证。
//
// 为什么挂真组件而不是复制逻辑：分组/归堆代码内联在 CommandCenter.tsx 里，不是可提取的
// 纯函数（「为测试重构生产代码」不在测试员权限内），而渲染层又没有快照测试环境。仓内对
// 这个处境的既有答案是 esbuild + jsdom 挂载点（先例：tests/commandPageGroups.test.cjs、
// tests/agentbusPanel.test.cjs、tests/toolExecutionPlacement.test.cjs —— 均已登记进
// package.json 的 test 脚本）。本文件照此成例挂真 CommandCenter + 假
// __KHYOS__.slashList/slashRun，钉住只有挂载后才存在的行为：
//   C1 khy 行按载荷目录分组；组头序 = 静态四组在前 + 目录序 + 目录外键按出现序补后
//      （label 回落键名，不编中文名）；静态四组计数证明四个回调 props 都传了
//      （视图组整组在 if (onPanelAction) 里，文件组同理，新建/重载在另两个 if 里）。
//   C2 组头用目录中文 label 而非键名。
//   C3 跨组 data-index 连续 0..n-1（分组不破坏 ↑↓/Enter 的平坦索引契约）。
//   C4 搜组名带整组（分组后 filter 的 category 字段是中文组名）。
//   C5 runnable !== 'routed' 的行仍不进面板（prompt 走 Composer 的 / 菜单，none 无通道）。
//
// 手法照 commandPageGroups.test.cjs：esbuild 打包 tests/commandCenterGroups.harness.tsx，
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

const bundlePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khycmdctr-ui-')), 'harness.cjs')
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'tests', 'commandCenterGroups.harness.tsx')],
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
// jsdom 没有 Element.prototype.scrollIntoView：CommandCenter 滚动选中项的 useEffect
// 会因此抛 TypeError，整棵树被卸载，所有断言跟着空。
if (!dom.window.Element.prototype.scrollIntoView) {
  dom.window.Element.prototype.scrollIntoView = () => {}
}

const { mount, unmount, setList } = require(bundlePath)

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
const root = () => document.getElementById('root')
const text = () => root().textContent || ''
// 列表容器 = 唯一带 max-h-80 overflow-auto 的面板主体；其直接子 div 是组壳，
// 组壳的第一个子元素是组头（纯文本），行按钮都在组壳里。
const list = () => root().querySelector('.max-h-80.overflow-auto')
const groupWrappers = () => [...list().children]
const headerTexts = () => groupWrappers().map((w) => w.firstElementChild.textContent.trim())
const byHeader = (title) => groupWrappers().find((w) => w.firstElementChild.textContent.trim() === title)
const rowsIn = (title) => byHeader(title).querySelectorAll('button[data-index]')
const rowButtons = () => [...list().querySelectorAll('button[data-index]')]
// 面板的输入框没有显式 type 属性（默认 text），不能按 input[type="text"] 选
const type = async (value) => {
  const input = root().querySelector('input')
  assert.ok(input, '应渲染搜索框')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await flush()
}

// Teardown is defensive on purpose（commandPageGroups.test.cjs 同款理由）：unmount 抛了
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

// ── 夹具：目录与行形状对齐 main 侧 slashCommandGroups() / listSlashCommands() 的出口 ──

const CATALOG = [
  { key: 'model', label: 'AI 模型' },
  { key: 'data', label: '数据管理' },
  { key: 'security', label: '安全' },
  { key: 'dev', label: '开发工具' },
  { key: 'workflow', label: '工作流' },
  { key: 'system', label: '系统' },
  { key: 'analysis', label: '分析' },
]

function row(cmd, label, description, runnable, groupKey) {
  return { id: `khy:${cmd}`, cmd, label, description, runnable, source: 'khy', aliases: [], groupKey }
}

// 行的**出现序**故意与目录序不同（analysis/workflow/model）：组序必须跟目录走，
// 跟出现序走的实现会在这里红。
const KHY_ROWS = [
  row('/habit', 'habit', '习惯统计', 'routed', 'analysis'),
  row('/memory', 'memory', '记忆管理', 'routed', 'workflow'),
  row('/model', 'model', '模型管理', 'routed', 'model'),
  // 目录里没有的键：补在最后，组头回落键名（不编中文名）
  row('/mystery', 'mystery', '目录外键', 'routed', 'mystery'),
  // 非 routed 行：面板不收（prompt 类在 Composer 的 / 菜单接 aiSend 管线，none 类无执行通道）
  row('/commit', 'commit', '生成提交信息', 'prompt', 'skill'),
  row('/study', 'study', '学习模式', 'none', 'system'),
]

// 四个回调必须全传：视图组整组在 if (onPanelAction) 里，文件组同理，新建任务/重载会话
// 在 if (onNewTask)/if (onReloadSession) 里。少传一个，静态四组就缺一支，
// 「静态四组在前 + 目录序」这个断言根本立不住。
const PROPS = {
  visible: true,
  onClose: () => {},
  onPanelAction: () => {},
  onNewTask: () => {},
  onReloadSession: () => {},
}

async function mountPanel(commands = KHY_ROWS, groups = CATALOG) {
  unmount()
  setList({ ok: true, commands, groups })
  mount({ ...PROPS })
  await flush()
}

// ── C1: 归堆与组序 ──────────────────────────────────────────────────────────

test('C1: khy 行按载荷目录分组，组序 = 静态四组在前 + 目录序 + 目录外键按出现序补后', async () => {
  await mountPanel()
  assert.deepEqual(
    headerTexts(),
    ['任务', '视图', '文件', '应用', 'AI 模型', '工作流', '分析', 'mystery'],
    '静态四组在前，其后按目录序（不是行的出现序），目录外键补后'
  )
  // 静态四组的条数：3/7/1/3 —— 同时证明四个回调 props 都传进来了
  assert.equal(rowsIn('任务').length, 3)
  assert.equal(rowsIn('视图').length, 7)
  assert.equal(rowsIn('文件').length, 1)
  assert.equal(rowsIn('应用').length, 3)
  // 每个 khy 组只装自己的行（归堆不串组）
  assert.equal(rowsIn('AI 模型').length, 1)
  assert.ok(byHeader('AI 模型').textContent.includes('模型管理'))
  assert.equal(rowsIn('工作流').length, 1)
  assert.ok(byHeader('工作流').textContent.includes('记忆管理'))
  assert.equal(rowsIn('分析').length, 1)
  assert.ok(byHeader('分析').textContent.includes('习惯统计'))
  assert.equal(rowsIn('mystery').length, 1)
  // 组内计数之和 = 总条数（分组不丢行的量化判据）
  const sum = groupWrappers().reduce((n, w) => n + w.querySelectorAll('button[data-index]').length, 0)
  assert.equal(sum, 18, '静态 14 条 + routed khy 4 条')
})

// ── C2: 组头文案取自目录 label ──────────────────────────────────────────────

test('C2: 组头用目录中文 label 而非键名；目录外的键回落键名', async () => {
  await mountPanel()
  const heads = headerTexts()
  assert.ok(heads.includes('AI 模型'), '目录内的键必须显示中文组名')
  assert.ok(!heads.includes('model'), '不得把键名当组名显示')
  assert.ok(!heads.includes('analysis'), '不得把键名当组名显示')
  assert.ok(heads.includes('mystery'), '目录外键回落键名本身（不编中文名）')
})

// ── C3: 跨组 data-index 连续 ────────────────────────────────────────────────

test('C3: 跨组 data-index 连续 0..n-1（分组不破坏键盘导航契约）', async () => {
  await mountPanel()
  const idx = rowButtons().map((b) => Number(b.getAttribute('data-index')))
  assert.equal(idx.length, 18)
  assert.deepEqual(idx, idx.map((_, i) => i), '分组后 ↑↓/Enter 仍按连续平坦索引到达每一行')
})

// ── C4: 搜组名带整组 ────────────────────────────────────────────────────────

test('C4: 搜组名带整组（filter 的 category 字段是目录中文名），未命中组整块不渲染', async () => {
  await mountPanel()
  await type('分析')
  assert.deepEqual(headerTexts(), ['分析'], '组名命中带整组')
  assert.ok(text().includes('习惯统计'))
  assert.ok(!text().includes('模型管理'), '未命中组整块不渲染')
  assert.ok(!text().includes('设置'), '静态组不因一个 khy 组名命中而出现')
  await type('')
  assert.equal(headerTexts().length, 8, '清空回归全量分组')
})

// ── C5: 非 routed 行不进面板 ────────────────────────────────────────────────

test('C5: runnable !== routed 的行仍不进面板（prompt/none 没有可执行通道）', async () => {
  await mountPanel()
  assert.ok(text().includes('模型管理'), 'routed 行在面板里')
  assert.ok(!text().includes('生成提交信息'), 'prompt 行（技能/CC）不进面板')
  assert.ok(!text().includes('学习模式'), 'none 行不进面板')
  assert.equal(rowButtons().length, 18, '面板只有 routed 行')
})
