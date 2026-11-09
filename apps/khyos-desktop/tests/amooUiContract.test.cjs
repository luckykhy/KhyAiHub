// 桌面端 amoo 入口的源码契约：接线是「字符串 + 状态机」写成的，类型检查抓不到
// 「磁贴没接上 switch」「命令面板 action 拼错」这类断链。这里直接读源文件断言。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const sidePane = read('src/renderer/components/layout/SidePane.tsx')
const appLayout = read('src/renderer/components/layout/AppLayout.tsx')
const commandCenter = read('src/renderer/components/message/CommandCenter.tsx')
// amoon 面板拆成主件 + 发送节 + 回执节 + 面板共用小件四份源文件（metrics 闸门 B2），
// 契约断言对四份拼接文本跑，不变量一条不减。
const amoonPane = [
  'src/renderer/components/amoon/AmoonPane.tsx',
  'src/renderer/components/amoon/AmoonSendSection.tsx',
  'src/renderer/components/amoon/AmoonInboxSection.tsx',
  'src/renderer/components/amoon/amoonShared.tsx',
]
  .map(read)
  .join('\n')
const preload = read('src/preload/index.ts')
const main = read('src/main/index.ts')

test('SidePane：PaneTabKind / 磁贴 / TabBody 三处都接上 amoon', () => {
  assert.match(sidePane, /PaneTabKind\s*=[^;]*'amoon'/, 'PaneTabKind 必须包含 amoon')
  assert.match(sidePane, /kind:\s*'amoon'/, 'TAB_TILES 必须有 amoon 磁贴')
  assert.match(sidePane, /case\s+'amoon'\s*:\s*\n\s*return\s+<AmoonPane/, 'TabBody 必须渲染 AmoonPane')
  // AmoonPane 必须被引入 —— 静态 import 或懒加载（React.lazy）都算。
  // 剥洋葱 · 视觉侧第一刀（[DESIGN-ARCH-197] §6.3）把 SidePane 的 7 个面板
  // 改成了 React.lazy：面板是低频的，不该在首屏 bundle 里；但「amoon 已接线」
  // 这条契约的意图是功能完整，与加载方式无关。
  assert.match(
    sidePane,
    /import\s*\{\s*AmoonPane\s*\}|lazy\(\s*\(\)\s*=>\s*import\([^)]*amoon\/AmoonPane[^)]*\)/,
    '必须 import AmoonPane（静态或懒加载皆可）'
  )
})

test('AppLayout：标题表与命令 action 都接上', () => {
  // 2026-10-30：「amoo 秘书」标签同案落地，既有 amoon 标签改名「amoo 投递」，
  // 免得下一个人又把投递当成问答。
  assert.match(appLayout, /amoon:\s*'amoo 投递'/, 'TAB_TITLES（Record<PaneTabKind,string>）必须补 amoon')
  assert.match(appLayout, /case\s+'addAmoonTab'\s*:\s*openPaneTab\('amoon'\)/, 'addAmoonTab 必须落到 openPaneTab')
})

test('CommandCenter：视图分组有可执行的 amoo 命令', () => {
  assert.match(commandCenter, /id:\s*'add-amoon-tab'/, '命令 id 必须存在')
  assert.match(commandCenter, /onPanelAction\('addAmoonTab'\)/, '命令 action 必须与 AppLayout 对齐')
})

test('AmoonPane：渲染层不 fetch、不读 token 文件', () => {
  assert.doesNotMatch(amoonPane, /\bfetch\s*\(/, '渲染层不得直接 fetch（bridge 会 403 Origin）')
  assert.doesNotMatch(amoonPane, /\bfs\.|readFileSync|node:fs|require\(/, '渲染层不得自己读磁盘/token')
  assert.match(amoonPane, /__KHYOS__/, '只走 preload 注入的 API')
})

test('IPC：五个 amoon 通道在 preload 与 main 同名注册', () => {
  for (const channel of ['amoon:status', 'amoon:send', 'amoon:inbox', 'amoon:start', 'amoon:stop']) {
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload 缺少 ${channel}`)
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main 缺少 ${channel}`)
  }
})

test('面板四态：ok:false 带 phase 的状态必须被接受（回归：unhealthy 被吞成未运行）', () => {
  assert.match(amoonPane, /PHASES\.includes\(rec\.phase/, 'asStatus 必须按 phase 判断，而不是 ok')
  assert.doesNotMatch(amoonPane, /rec\.ok === false && rec\.error\) return null/, '不得再把 ok:false 状态丢弃')
})
