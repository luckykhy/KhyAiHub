// khy-canary: Khy-20261102-288-BGYYENEM
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'

// 剥洋葱 · 视觉侧第一刀：侧栏面板按需加载。
//
// 【为什么】SidePane 是多标签容器，7 个面板此前全部静态 import ——
// 用户不点那个标签，它的代码也进首屏 bundle。这是逻辑侧「能力放错层导致
// 重量前置」的同构病例：逻辑侧的正确解法是让能力归位，视觉侧的正确解法是
// 让面板按需加载。
//
// 【实测收益】AppLayout 的首屏冷闭包 38 文件 / 8777 行 → 21 文件 / 5148 行，
// 省 17 文件 / 3629 行。守卫 scripts/ci/check-core-layers.js 的
// `skin-into-visual-core` 判据盯着这件事。
//
// 【行为不变】面板原本就只在对应 tab 激活时才渲染；改为 lazy 后首次进入该
// tab 会多一次异步加载，由 Suspense 的 fallback 承接。命名导出用
// `.then(m => ({ default: m.X }))` 转成 lazy 需要的 default 形态。
const TerminalPanel = lazy(() => import('../terminal/Terminal').then((m) => ({ default: m.TerminalPanel })))
const GitPanel = lazy(() => import('../git/GitPanel').then((m) => ({ default: m.GitPanel })))
const BrowserPane = lazy(() => import('../browser/BrowserPane').then((m) => ({ default: m.BrowserPane })))
const SelectionChatPane = lazy(() =>
  import('../selection/SelectionChatPane').then((m) => ({ default: m.SelectionChatPane }))
)
const CodeViewerPane = lazy(() =>
  import('../viewer/CodeViewerPane').then((m) => ({ default: m.CodeViewerPane }))
)
const OpenFilePane = lazy(() => import('../viewer/OpenFilePane').then((m) => ({ default: m.OpenFilePane })))
const AmoonPane = lazy(() => import('../amoon/AmoonPane').then((m) => ({ default: m.AmoonPane })))
const AmooSecretaryPane = lazy(() => import('../amoon/AmooSecretaryPane').then((m) => ({ default: m.AmooSecretaryPane })))

// Side pane as a multi-tab container (sidePane.* i18n, ZC-ALIGN-003):
// empty state shows the 打开标签页 tile selector; open tabs render a strip
// with per-tab close + 新增标签 (back to selector) + the active pane body.

export type PaneTabKind = 'selectionChat' | 'review' | 'terminal' | 'browser' | 'openFile' | 'file' | 'amoon' | 'amooSecretary'

export interface PaneTab {
  id: string
  kind: PaneTabKind
  title: string
  // 'file' tabs carry the opened file path (title shows the file name)
  filePath?: string
  // 内置编辑器有未保存更改（AppLayout 经 onFileDirty 更新）：标题打脏点，
  // 关闭/切走前必须经人确认 —— 只渲染激活标签，不确认就丢编辑
  dirty?: boolean
}

interface SidePaneProps {
  visible: boolean
  tabs: PaneTab[]
  activeTabId: string | null
  hasSessions: boolean
  // Panel width in px (drag-resizable from its left edge, owned by AppLayout)
  width?: number
  // Selector tile click → open that tab kind (SidePane owns the selector view)
  onOpenTab: (kind: PaneTabKind) => void
  onTabSelect: (id: string) => void
  onTabClose: (id: string) => void
  // 打开文件选择器选中文件 → AppLayout 打开 codeViewer 标签（sidePane.openFile）
  onOpenFile: (filePath: string) => void
  // 内置编辑器脏状态 → AppLayout 更新标签 dirty 字段（关闭/切换前弹确认）
  onFileDirty?: (filePath: string, dirty: boolean) => void
  // Ctrl+Alt+B 切换面板：面板隐藏时也能呼出（快捷键注册在 visible 闸门之前）
  onToggle: () => void
  onClose: () => void
}

// Tile copy maps 1:1 to ZCode: 辅助对话 / 审查 / 终端 / 浏览器 + 打开文件
// (tiles render through the shared line-icon registry so they match the
// sidebar/home icons in weight and baseline; no system-font dingbat glyphs).
// 打开文件 is the sidePane.openFile quickPick (opens the file picker).
const TAB_TILES: { kind: PaneTabKind; label: string; icon: IconName; description: string }[] = [
  { kind: 'selectionChat', label: '辅助对话', icon: 'chat', description: '独立于主会话的小型问答' },
  { kind: 'review', label: '审查', icon: 'review', description: '查看工作区 Git 改动' },
  { kind: 'terminal', label: '终端', icon: 'terminal', description: '在面板中运行命令' },
  { kind: 'browser', label: '浏览器', icon: 'browser', description: '在面板中打开网页' },
  { kind: 'openFile', label: '打开文件', icon: 'open-file', description: '从工作区选择文件打开' },
  // amoo 投递：状态/发送/回执。本机未安装时也如实显示「未安装」，不是假在线。
  { kind: 'amoon', label: 'amoo 投递', icon: 'remote-mobile', description: '状态 · 发消息 · 回执（未验证）' },
  // amoo 秘书：提问/等回答/看结果。与「amoo 投递」分开命名 —— 投递只证明消息
  // 进了 outbox，秘书要的是手机那端真的回一句话，混成一个标签必被认错。
  { kind: 'amooSecretary', label: 'amoo 秘书', icon: 'remote-mobile', description: '提问 · 等回答 · 可中止（回复未验证）' },
]

function TabBody({
  kind,
  filePath,
  onOpenFile,
  onFileClose,
  onFileDirty,
}: {
  kind: PaneTabKind
  filePath?: string
  onOpenFile: (filePath: string) => void
  onFileClose: () => void
  onFileDirty?: (filePath: string, dirty: boolean) => void
}) {
  // 稳定 identity：编辑器的 onDirtyChange effect 依赖它，箭头每次渲染都新建
  // 会让 effect 反复空转（AppLayout 侧虽已幂等，这里也不必再制造触发）。
  const handleFileDirty = useCallback(
    (dirty: boolean) => onFileDirty?.(filePath || '', dirty),
    [filePath, onFileDirty],
  )
  const body = (() => {
    switch (kind) {
      case 'selectionChat':
        return <SelectionChatPane />
      case 'review':
        return <GitPanel />
      case 'terminal':
        return <TerminalPanel />
      case 'browser':
        return <BrowserPane />
      case 'openFile':
        return <OpenFilePane onOpenFile={onOpenFile} />
      case 'file':
        return <CodeViewerPane filePath={filePath || ''} onClose={onFileClose} onDirtyChange={handleFileDirty} />
      case 'amoon':
        return <AmoonPane />
      case 'amooSecretary':
        return <AmooSecretaryPane />
    }
  })()
  // 剥洋葱 · 视觉侧：lazy 面板的加载边界。fallback 用与面板同宽的骨架，
  // 避免切换 tab 瞬间塌陷（面板本身的骨架样式见 ui/Skeleton）。
  return <Suspense fallback={<div style={{ padding: 12 }} />}>{body}</Suspense>
}

export function SidePane({ visible, tabs, activeTabId, hasSessions, width, onOpenTab, onOpenFile, onTabSelect, onTabClose, onFileDirty, onToggle, onClose }: SidePaneProps) {
  // 搜索标签页 dropdown open state (closes on outside click / Escape)
  const [searchMenuOpen, setSearchMenuOpen] = useState(false)
  const searchMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!searchMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (searchMenuRef.current && !searchMenuRef.current.contains(e.target as Node)) {
        setSearchMenuOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [searchMenuOpen])

  // Shortcuts are registered BEFORE the visible gate so they also work while
  // the pane is hidden: Ctrl+Alt+B toggles (parent decides direction),
  // Ctrl+J opens/focuses a terminal tab (sidePane.openTab convention).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key === 'b') {
        e.preventDefault()
        onToggle()
      }
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault()
        onOpenTab('terminal')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle, onOpenTab])

  if (!visible) return null

  const activeTab = tabs.find((t) => t.id === activeTabId) || null

  return (
    <div
      className="bg-panel border-l border-border-strong flex flex-col h-full animate-slide-up"
      style={width ? { width: `${width}px` } : undefined}
    >
      {/* 标签栏：每标签一个条目 + 关闭按钮；新增标签回到选择器 */}
      <div className="flex border-b border-border items-center">
        <div className="flex flex-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 pl-3 pr-1.5 py-2.5 text-sm font-medium transition-all duration-150 relative cursor-pointer ${
                activeTabId === tab.id
                  ? 'text-brand bg-brand-subtle'
                  : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
              }`}
              onClick={() => onTabSelect(tab.id)}
            >
              {/* 脏点：内置编辑器有未保存更改（关闭/切走前会先确认） */}
              {tab.dirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-warning shrink-0"
                  title="未保存更改"
                  aria-label="未保存更改"
                />
              )}
              <span className="truncate max-w-24">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(tab.id)
                }}
                // 热区 20×20（负 margin 吸收布局增量，标签排布不变），
                // 字形仍 11px —— 16×16 的点击目标在 14px 标签行里太小
                className="w-5 h-5 -m-0.5 rounded flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                aria-label={`关闭 ${tab.title}`}
              >
                <Icon name="close" size={11} />
              </button>
              {activeTabId === tab.id && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-brand rounded-full" />
              )}
            </div>
          ))}
          {/* 新增标签（sidePane.addTab）→ 回到选择器：清空 activeTabId */}
          <button
            onClick={() => onTabSelect('')}
            title="新增标签"
            className="w-8 flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
            aria-label="新增标签"
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        {/* 搜索标签页（sidePane.tabOverview，ZCode s-45 实测 has_menu）：下拉
            列出全部标签，点击聚焦；无标签时显示 noTabsFound 空态行 */}
        <div ref={searchMenuRef} className="relative shrink-0">
          <button
            onClick={() => setSearchMenuOpen((v) => !v)}
            className="p-2 text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-md transition-colors"
            title="搜索标签页"
            aria-label="搜索标签页"
            aria-haspopup="menu"
            aria-expanded={searchMenuOpen}
          >
            <Icon name="search" size={14} />
          </button>
          {searchMenuOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg py-1 z-50 animate-scale-in origin-top-right"
              role="menu"
            >
              <div className="px-3 py-1.5 text-xs font-medium text-foreground">
                打开的标签页
              </div>
              {tabs.length === 0 ? (
                <div className="px-3 py-2 text-xs text-foreground-muted">
                  没有找到标签页。
                </div>
              ) : (
                tabs.map((tab) => (
                  <button
                    key={tab.id}
                    role="menuitem"
                    onClick={() => {
                      onTabSelect(tab.id)
                      setSearchMenuOpen(false)
                    }}
                    className={`w-full px-3 py-1.5 text-left text-sm truncate transition-colors ${
                      activeTabId === tab.id
                        ? 'text-foreground bg-selected'
                        : 'text-foreground/70 hover:text-foreground hover:bg-surface-hover'
                    }`}
                  >
                    {tab.title}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-md mr-1 transition-colors"
          aria-label="关闭面板"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {/* 内容区：无激活标签时显示「打开标签页」选择器；否则显示标签体 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!activeTab ? (
          <div className="flex flex-col h-full overflow-auto">
            <div className="px-4 pt-5 pb-1">
              <h3 className="text-sm font-medium text-foreground">打开标签页</h3>
              <p className="text-xs text-foreground-muted mt-1">选择要在侧边面板中打开的标签。</p>
            </div>
            {/* 单列磁贴：面板宽度有限，2 列网格装 5 项会让第五块独占半行、
                右半格留空，读起来像漏了一块 */}
            <div className="grid grid-cols-1 gap-2 px-4 py-3">
              {TAB_TILES.filter((t) => t.kind !== 'selectionChat' || hasSessions).map((tile) => (
                <button
                  key={tile.kind}
                  onClick={() => onOpenTab(tile.kind)}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-surface-hover hover:border-border-strong transition-colors text-left"
                >
                  <Icon name={tile.icon} size={18} className="text-foreground/70 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{tile.label}</div>
                    <div className="text-xs text-foreground-muted mt-0.5">{tile.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* 标签体挂载区：非激活标签保持挂载会保住终端会话/表单状态；
                但当前先只渲染激活标签（与 ZCode 面板行为一致的轻量起点） */}
            <TabBody
              key={activeTab.id}
              kind={activeTab.kind}
              filePath={activeTab.filePath}
              onOpenFile={onOpenFile}
              onFileClose={() => onTabClose(activeTab.id)}
              onFileDirty={onFileDirty}
            />
          </>
        )}
      </div>
    </div>
  )
}
