// keymapContract.test.mjs — 快捷键契约（[DESIGN-ARCH-125] §8.2 验收判据的机检化）
//
// 该文档的验收判据是：「命令面板/窗口菜单里每一条**展示**的快捷键，按下后都必须
// 触发对应动作；不出现『点了没反应』的项」。此前这条判据靠人工，于是：
//   · Ctrl+N / Ctrl+O 被展示了两期，实际没有任何实现（menu.ts 零 importer）
//   · menu.ts 自己定义了 9 条加速键，而主进程 Menu.setApplicationMenu(null) 把原生
//     菜单摘了，8 条 menu:* 通道零接收方 —— 整份文件是悬空件
// 本测试把判据拆成三层可机检断言：
//   A. 解析语义（纯函数行为）—— 修饰位必须精确匹配，否则 Ctrl+Shift+K 会被 Ctrl+K 吞
//   B. 表内不变量 —— 键位不重复、展示字符串与修饰位标志一致（徽标不许骗人）
//   C. 接线闭环 —— 每个登记动作在渲染层有消费点，且窗口级动作的 IPC 在 main/preload 双侧存在
//
// Run: node --experimental-strip-types --test tests/keymapContract.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(projectRoot, rel), 'utf-8')

// keymap.ts 是纯叶子（零 IO / 确定性 / 不抛异常），所以能直接在 Node 里 import ——
// 这正是它被设计成叶子的理由之一（见其头部「范式与 TUI 侧 chatChords.js 对齐」）。
const keymap = await import('../src/renderer/shared/keymap.ts')
const { KEY_BINDINGS, resolveDesktopAction, keyLabelFor } = keymap

// ── A. 解析语义 ────────────────────────────────────────────────────────────

test('A1: 已知组合解析为对应动作', () => {
  assert.equal(resolveDesktopAction({ key: 'n', ctrlKey: true }), 'newTask')
  assert.equal(resolveDesktopAction({ key: 'o', ctrlKey: true }), 'openWorkspace')
  assert.equal(resolveDesktopAction({ key: 'k', ctrlKey: true }), 'commandCenter')
  assert.equal(resolveDesktopAction({ key: 't', ctrlKey: true }), 'cycleThoughtLevel')
  assert.equal(resolveDesktopAction({ key: ',', ctrlKey: true }), 'openSettings')
  assert.equal(resolveDesktopAction({ key: 'j', ctrlKey: true }), 'toggleTerminal')
  assert.equal(resolveDesktopAction({ key: 'b', ctrlKey: true, altKey: true }), 'toggleSidePane')
})

test('A2: Ctrl+Shift+K 不被 Ctrl+K 吞掉（精确修饰位）', () => {
  // 这条是真实缺陷的形状：keymap 头部注释专门写了「Ctrl+Shift+K 不该被 Ctrl+K 吞掉」。
  // 若解析退化成「修饰位超集匹配」，密钥与端点管理会被命令面板抢走。
  assert.equal(resolveDesktopAction({ key: 'k', ctrlKey: true, shiftKey: true }), 'openKeyManager')
  assert.equal(resolveDesktopAction({ key: 'k', ctrlKey: true }), 'commandCenter')
  assert.equal(resolveDesktopAction({ key: 'k', ctrlKey: true, shiftKey: true, altKey: true }), null)
})

test('A3: 表外修饰位一律不命中（不误吞系统快捷键）', () => {
  // metaKey（Cmd）组合本表不绑定：桌面端是 Windows 优先的无边框形态，
  // 认了 meta 会在 macOS 上抢系统键。
  assert.equal(resolveDesktopAction({ key: 'n', ctrlKey: true, metaKey: true }), null)
  assert.equal(resolveDesktopAction({ key: 'n', metaKey: true }), null)
  // 多按一个修饰位不构成命中
  assert.equal(resolveDesktopAction({ key: 'n', ctrlKey: true, altKey: true }), null)
  assert.equal(resolveDesktopAction({ key: 'n', ctrlKey: true, shiftKey: true }), null)
})

test('A4: 无修饰位键（F11/F12）命中且大小写无关', () => {
  assert.equal(resolveDesktopAction({ key: 'F11' }), 'toggleFullScreen')
  assert.equal(resolveDesktopAction({ key: 'f11' }), 'toggleFullScreen')
  assert.equal(resolveDesktopAction({ key: 'F12' }), 'toggleDevTools')
  assert.equal(resolveDesktopAction({ key: 'f12' }), 'toggleDevTools')
  // 带修饰位就不再是这两个动作
  assert.equal(resolveDesktopAction({ key: 'f11', altKey: true }), null)
})

test('A5: 缺参 / 表外键 / 空键不抛异常且返回 null', () => {
  assert.equal(resolveDesktopAction(), null)
  assert.equal(resolveDesktopAction(null), null)
  assert.equal(resolveDesktopAction({}), null)
  assert.equal(resolveDesktopAction({ key: '' }), null)
  assert.equal(resolveDesktopAction({ key: 'z', ctrlKey: true }), null)
  assert.equal(resolveDesktopAction({ key: 42, ctrlKey: true }), null)
})

// ── B. 表内不变量 ─────────────────────────────────────────────────────────

test('B1: 无两条绑定抢同一组合（先命中者赢 = 静默遮蔽）', () => {
  const seen = new Map()
  for (const b of KEY_BINDINGS) {
    const sig = [b.key, !!b.ctrl, !!b.alt, !!b.shift].join('|')
    assert.ok(!seen.has(sig), `键位组合被两个动作共用：${sig} → ${seen.get(sig)} 与 ${b.action}`)
    seen.set(sig, b.action)
  }
})

test('B2: 展示字符串唯一，且与修饰位标志一致（徽标不许骗人）', () => {
  const labels = new Map()
  for (const b of KEY_BINDINGS) {
    assert.ok(b.keys, `${b.action} 缺展示键位字符串`)
    assert.ok(b.label, `${b.action} 缺人类可读标签`)
    assert.ok(!labels.has(b.keys), `展示键位重复：${b.keys}（${labels.get(b.keys)} / ${b.action}）`)
    labels.set(b.keys, b.action)

    assert.equal(b.keys.includes('Ctrl'), !!b.ctrl, `${b.action}: 展示串与 ctrl 标志不一致`)
    assert.equal(b.keys.includes('Alt'), !!b.alt, `${b.action}: 展示串与 alt 标志不一致`)
    assert.equal(b.keys.includes('Shift'), !!b.shift, `${b.action}: 展示串与 shift 标志不一致`)
    const last = b.keys.split('+').pop()
    const expected = /^f\d+$/.test(b.key) ? b.key.toUpperCase() : b.key.toUpperCase()
    assert.equal(last, expected, `${b.action}: 展示串末段应为主键 ${expected}，实为 ${last}`)
  }
})

test('B3: keyLabelFor 对未登记动作返回空串（调用方据此不渲染假快捷键）', () => {
  assert.equal(keyLabelFor('newTask'), 'Ctrl+N')
  assert.equal(keyLabelFor('openKeyManager'), 'Ctrl+Shift+K')
  assert.equal(keyLabelFor('toggleFullScreen'), 'F11')
  assert.equal(keyLabelFor('toggleDevTools'), 'F12')
  // @ts-expect-error 故意传表外动作名：契约要求返回空串而非抛异常
  assert.equal(keyLabelFor('nopeNotAnAction'), '')
})

// ── C. 接线闭环（「展示即事实」的机器守卫）────────────────────────────────

const CONSUMER_FILES = {
  'src/renderer/App.tsx': ['commandCenter', 'newTask', 'openWorkspace', 'openSettings', 'openKeyManager', 'cycleThoughtLevel', 'toggleFullScreen', 'toggleDevTools'],
  'src/renderer/components/layout/AppLayout.tsx': ['toggleSidePane', 'toggleTerminal'],
}

test('C1: 每个登记动作在渲染层都有消费点（否则按下没反应 = 展示在骗人）', () => {
  const sources = Object.fromEntries(Object.keys(CONSUMER_FILES).map((f) => [f, read(f)]))
  for (const [file, actions] of Object.entries(CONSUMER_FILES)) {
    for (const action of actions) {
      assert.ok(
        sources[file].includes(`action === '${action}'`),
        `${file} 里没有消费 action === '${action}' —— keymap 登记了它，按下却不会有反应`
      )
    }
  }
  // 反向：表里每个动作都必须出现在上面某张消费清单里，防「加了绑定忘了接线」
  const claimed = new Set(Object.values(CONSUMER_FILES).flat())
  for (const b of KEY_BINDINGS) {
    assert.ok(claimed.has(b.action), `${b.action} 已登记进 KEY_BINDINGS，但没有任何消费点清单声明它`)
  }
})

test('C2: 窗口级动作的 IPC 通道在 main 与 preload 双侧存在（闭环）', () => {
  const main = read('src/main/index.ts')
  const preload = read('src/preload/index.ts')
  const pairs = [
    ['keymanager:openWindow', 'openKeyManagerWindow'],
    ['window:toggleFullScreen', 'toggleFullScreen'],
    ['devtools:toggle', 'toggleDevTools'],
  ]
  for (const [channel, method] of pairs) {
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main 未注册 IPC 通道 ${channel}`)
    assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload 未暴露 ${channel}`)
    assert.ok(preload.includes(`${method}:`), `preload 缺少方法 ${method}`)
  }
})

test('C3: 密钥与端点管理入口① 在自绘窗口菜单里存在（[DESIGN-ARCH-091] §5.1）', () => {
  const titleBar = read('src/renderer/components/layout/TitleBar.tsx')
  assert.ok(titleBar.includes('密钥与端点管理'), 'TitleBar 窗口菜单缺少「密钥与端点管理」项')
  assert.ok(
    titleBar.includes("keyLabelFor('openKeyManager')"),
    '菜单项的键位徽标必须从 keymap 单一真源派生，不得手写字符串'
  )
})

test('C4: 不复辟第二份快捷键真源（menu.ts 悬空件不得回来）', () => {
  // [DESIGN-ARCH-125] §5.2 step 4「删除或引入 main/menu.ts，二选一，不留悬空件」——
  // 本次取「删除」分支；§6 陷阱 #7 明确禁止把原生菜单装回（与无边框 + 自绘标题栏冲突）。
  assert.ok(
    !existsSync(join(projectRoot, 'src/main/menu.ts')),
    'main/menu.ts 已按 [DESIGN-ARCH-125] §5.2 step 4 删除；若要恢复该能力，请接进 '
      + 'renderer/shared/keymap.ts 单一真源，而不是重建第二份快捷键表'
  )
  // 原生菜单必须保持摘除状态（无边框形态的前提）
  assert.ok(
    read('src/main/index.ts').includes('Menu.setApplicationMenu(null)'),
    'main/index.ts 应保持 Menu.setApplicationMenu(null)：无边框窗口 + 自绘标题栏形态下装回原生菜单会与之冲突'
  )
})