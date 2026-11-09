// khy-canary: Khy-20261102-286-HRB86W5S
import { useState, useCallback, useEffect, useRef, Suspense, lazy } from 'react'
import { TitleBar } from './TitleBar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { SidePane } from './SidePane'
import type { PaneTab, PaneTabKind } from './SidePane'
import { usePanelWidth } from './usePanelWidth'
import { KhyPet } from '../pet/KhyPet'
import {
  SESSION_LIST_TIMEOUT_MS,
  nextRetryDelay,
  resolveSessionTitle,
} from './sessionListLoad'
import { useAppDispatch } from '../../state/store'
import { setCurrentSession } from '../../state/messageSlice'
import { resolveDesktopAction } from '../../shared/keymap'

// Shape of a persisted REPL session as returned by the host bridge
// (sessionPersistence.listPersistedSessions, CH-2).
interface RealSession {
  sessionId: string
  title: string
  model: string
  messageCount: number
  createdAt: number
  updatedAt: number
  projectDir: string
  cwd: string
  firstUserMessage: string
}

interface AppLayoutProps {
  children: React.ReactNode
  // Command center (Ctrl+K) lives at layout level so its panel commands can
  // drive the side-pane tab state machine (moved up from App, ZC-ALIGN-003).
  commandCenterOpen: boolean
  onCommandCenterClose: () => void
  // 新建任务（侧栏 Ctrl+N / 底部「新建任务」）→ App 层清会话回启动卡片页
  onNewTask?: () => void
  // 选中历史会话 → App 层加载该会话的真实消息流（session:messages 桥）
  onTaskSelect?: (id: string) => void
  // 选中会话的标题（TitleBar 会话 tab 头，ZCode D5 实测）
  sessionTitle?: string
  // 「重载会话」按钮 → App 层重新拉取当前会话消息
  onReloadSession?: () => void
}

const TAB_TITLES: Record<PaneTabKind, string> = {
  selectionChat: '辅助对话',
  review: '审查',
  terminal: '终端',
  browser: '浏览器',
  openFile: '打开文件',
  // 'file' tabs show the opened file name as title (set in openFileTab)
  file: '代码查看',
  amoon: 'amoo 投递',
  amooSecretary: 'amoo 秘书',
}

let paneTabSeq = 0

// Panel width ranges (px) — ZCode clamps sidebar ~220–600 and side pane
// ~240–800; persisted via settings.json desktopSidebarWidth /
// desktopSidePaneWidth (usePanelWidth).
const SIDEBAR_WIDTH = { default: 260, min: 200, max: 480 }
const SIDEPANE_WIDTH = { default: 300, min: 220, max: 640 }

// 剥洋葱 · 视觉侧第三刀：命令面板（Ctrl+K）按需加载。
//
// 归因实测：CommandCenter 是 AppLayout 的第三大直接依赖（可达 1,230 行 / 10 模块），
// 而它**只在 Ctrl+K 时可见** —— CommandCenter.tsx 自身第 181 行 `if (!visible) return null`，
// 不可见时不渲染任何东西。此前静态 import，于是它一直在首屏 bundle 里。
//
// 与前两刀同型（React.lazy + Suspense），语义等价：
// 原先组件常驻挂载、靠 visible 返回 null；现在父层做条件渲染，
// 首次 Ctrl+K 时才挂载 —— 不可见时本来就不渲染任何东西，故行为不变。
const CommandCenter = lazy(() => import('../message/CommandCenter').then((m) => ({ default: m.CommandCenter })))

export function AppLayout({ children, commandCenterOpen, onCommandCenterClose, onNewTask, onTaskSelect, sessionTitle, onReloadSession }: AppLayoutProps) {
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidePaneVisible, setSidePaneVisible] = useState(false)
  // Side pane tab state machine: tabs[] + activeTabId (null = selector view).
  const [paneTabs, setPaneTabs] = useState<PaneTab[]>([])
  const [activePaneTabId, setActivePaneTabId] = useState<string | null>(null)
  // 未保存更改拦截：关闭/切走带脏点的文件标签前先问人（取消 / 放弃更改继续）
  const [pendingUnsaved, setPendingUnsaved] = useState<
    { kind: 'close'; tabId: string } | { kind: 'select'; tabId: string; nextId: string | null } | null
  >(null)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  // 会话导航历史（TitleBar 后退/前进，ZCode D1 实测）。栈里放 sessionId，
  // 空串代表「新任务」首页；索引指针即当前位置。
  const [navHistory, setNavHistory] = useState<string[]>([''])
  const [navIndex, setNavIndex] = useState(0)
  // Same value as navIndex, readable from inside setState updaters (the
  // updater closure cannot see the freshest state).
  const navIndexRef = useRef(0)
  // Workspace switch epoch: 打开工作区 成功后自增，用于重挂载文件树视图
  // （FileTree 挂载时按当前工作区根拉树，换根必须重新挂载才会重新拉取）
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0)
  // ZCode 实测侧栏视图 tab 为「项目/分组」：项目 = 按项目浏览（时间线），
  // 分组 = 按分组浏览。默认「项目」（ZC-ALIGN-001 P3-2，第八轮）。
  const [viewMode, setViewMode] = useState<'grouped' | 'chronological'>('chronological')
  const [searchQuery, setSearchQuery] = useState('')

  // Drag-resizable panel widths (workspaceSidebar.resizeSidebar /
  // sidePane.restoreSize), persisted to settings.json
  const sidebar = usePanelWidth({
    settingsKey: 'desktopSidebarWidth',
    defaultWidth: SIDEBAR_WIDTH.default,
    min: SIDEBAR_WIDTH.min,
    max: SIDEBAR_WIDTH.max,
  })
  const sidePaneSize = usePanelWidth({
    settingsKey: 'desktopSidePaneWidth',
    defaultWidth: SIDEPANE_WIDTH.default,
    min: SIDEPANE_WIDTH.min,
    max: SIDEPANE_WIDTH.max,
  })

  // Real REPL session list pulled from the backend via the host bridge
  // (replaces the previous static mock tasks — ZC-ALIGN-001 session wiring).
  const [tasks, setTasks] = useState<WorkspaceSidebarTask[]>([])
  const [sessionError, setSessionError] = useState('')
  // 列表加载中（用于骨架态与「正在重试」提示）。已有列表时不清空内容。
  const [sessionLoading, setSessionLoading] = useState(false)
  // 自动重试的调度句柄 + 当前尝试次数。手动「重试」会把次数归零重来。
  const retryTimerRef = useRef<number | null>(null)
  const attemptRef = useRef(0)
  // loadTasks 自引用（重试链要能再调自己）：用 ref 打断 useCallback 的循环依赖。
  const loadTasksRef = useRef<(attempt: number) => void>(() => {})

  const toggleSidebar = useCallback(() => setSidebarVisible(v => !v), [])
  const handleSidePaneClose = useCallback(() => setSidePaneVisible(false), [])

  // 切换面板：无标签/已隐藏 → 打开；有标签且已显示 → 收起（quickPick.toggleSidePane）
  const toggleSidePane = useCallback(() => {
    setSidePaneVisible(v => !v)
  }, [])

  // Open (or focus the existing) side-pane tab of the given kind. Multiple
  // tabs of the same kind are allowed in ZCode; until per-tab instances
  // exist we dedupe to one live tab per kind so Ctrl+J focuses, not stacks.
  const openPaneTab = useCallback((kind: PaneTabKind) => {
    setSidePaneVisible(true)
    setPaneTabs((tabs) => {
      const existing = tabs.find((t) => t.kind === kind)
      if (existing) {
        setActivePaneTabId(existing.id)
        return tabs
      }
      const id = `pane_${kind}_${++paneTabSeq}`
      setActivePaneTabId(id)
      return [...tabs, { id, kind, title: TAB_TITLES[kind] }]
    })
  }, [])

  const handleTabSelect = useCallback((id: string) => {
    // 只渲染激活标签：带未保存更改切走 = 静默丢编辑。先拦下人。
    const leaving = paneTabs.find((t) => t.id === activePaneTabId)
    if (leaving?.dirty && leaving.id !== id) {
      setPendingUnsaved({ kind: 'select', tabId: leaving.id, nextId: id || null })
      return
    }
    setActivePaneTabId(id || null)
  }, [paneTabs, activePaneTabId])

  // 打开文件（sidePane.openFile）：同一文件已有标签 → 聚焦；否则新开 codeViewer
  // 标签，标题为文件名（codeViewer.title = 代码查看 的按文件实例）
  const openFileTab = useCallback((filePath: string) => {
    setSidePaneVisible(true)
    setPaneTabs((tabs) => {
      const existing = tabs.find((t) => t.kind === 'file' && t.filePath === filePath)
      if (existing) {
        setActivePaneTabId(existing.id)
        return tabs
      }
      const name = filePath.split(/[\\/]/).pop() || filePath
      const id = `pane_file_${++paneTabSeq}`
      setActivePaneTabId(id)
      return [...tabs, { id, kind: 'file', title: name, filePath }]
    })
  }, [])

  // 内置编辑器脏状态 → 打脏点（PaneTab.dirty）。按 filePath 定位标签：
  // 同一文件只开一个标签（openFileTab 去重），filePath 是稳定键。
  // 值没变时原样返回 tabs（同引用）—— 渲染层的 onDirtyChange 箭头每次渲染
  // 都是新identity，编辑器 effect 会重复触发；不幂等的话这里每次都给新数组，
  // 反过来再触发渲染，成环。
  const handleFileDirty = useCallback((filePath: string, dirty: boolean) => {
    setPaneTabs((tabs) => {
      const tab = tabs.find((t) => t.kind === 'file' && t.filePath === filePath)
      if (!tab || (tab.dirty === true) === dirty) return tabs
      return tabs.map((t) => (t.kind === 'file' && t.filePath === filePath ? { ...t, dirty } : t))
    })
  }, [])

  // 关闭标签的实体（无脏检查）。调用方负责先清脏点或已确认。
  const closeTabNow = useCallback((id: string) => {
    setPaneTabs((tabs) => {
      const idx = tabs.findIndex((t) => t.id === id)
      if (idx === -1) return tabs
      const next = tabs.filter((t) => t.id !== id)
      setActivePaneTabId((current) => {
        if (current !== id) return current
        // 关闭的是激活标签 → 聚焦相邻标签；全空则回到选择器
        const neighbor = next[Math.min(idx, next.length - 1)]
        return neighbor ? neighbor.id : null
      })
      return next
    })
  }, [])

  const handleTabClose = useCallback((id: string) => {
    const target = paneTabs.find((t) => t.id === id)
    if (target?.dirty) {
      setPendingUnsaved({ kind: 'close', tabId: id })
      return
    }
    closeTabNow(id)
  }, [paneTabs, closeTabNow])

  // 切换终端（quickPick.toggleTerminal）：有终端标签 → 聚焦/收起面板；无 → 新开
  const toggleTerminal = useCallback(() => {
    setPaneTabs((tabs) => {
      const existing = tabs.find((t) => t.kind === 'terminal')
      if (existing) {
        setActivePaneTabId(existing.id)
        setSidePaneVisible((visible) => (existing.id === activePaneTabIdRef.current && visible ? false : true))
        return tabs
      }
      const id = `pane_terminal_${++paneTabSeq}`
      setActivePaneTabId(id)
      setSidePaneVisible(true)
      return [...tabs, { id, kind: 'terminal', title: TAB_TITLES.terminal }]
    })
  }, [])

  // Track the focused tab id for toggleTerminal without re-subscribing the
  // callback (activePaneTabId read through a ref inside setState updater).
  const activePaneTabIdRef = useRef<string | null>(null)
  activePaneTabIdRef.current = activePaneTabId

  // Command-center panel actions (quickPick.command.* wiring)
  const handlePanelAction = useCallback((action: string, arg?: string) => {
    switch (action) {
      case 'toggleSidePane': toggleSidePane(); break
      case 'toggleTerminal': toggleTerminal(); break
      case 'addTerminalTab': openPaneTab('terminal'); break
      case 'addBrowserTab': openPaneTab('browser'); break
      case 'addReviewTab': openPaneTab('review'); break
      case 'addSelectionChatTab': openPaneTab('selectionChat'); break
      case 'addAmoonTab': openPaneTab('amoon'); break
      case 'openFileTab': openPaneTab('openFile'); break
      case 'openFile': if (arg) openFileTab(arg); break
    }
  }, [toggleSidePane, toggleTerminal, openPaneTab, openFileTab])

  // 面板快捷键（Ctrl+Alt+B / Ctrl+J）：键位取自 shared/keymap.ts 的单一真源，
  // 副作用留在本组件（它是 side-pane 状态机的主人）。与 App 层的全局链共用同一
  // 张表，所以命令面板展示的键位和这里的实际行为不会脱节
  // （[DESIGN-ARCH-125] P-03）。此前这两个键只写在命令面板的展示字符串里，
  // 按下没有任何反应。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = resolveDesktopAction(e)
      if (action === 'toggleSidePane') {
        e.preventDefault()
        toggleSidePane()
      } else if (action === 'toggleTerminal') {
        e.preventDefault()
        toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidePane, toggleTerminal])

  // 会话选中/自动首会话同步到 messageSlice.currentSessionId（AppHeader 显示真源）
  const dispatch = useAppDispatch()
  const activeTaskIdRef2 = useRef<string | null>(activeTaskId)
  activeTaskIdRef2.current = activeTaskId

  const handleTaskSelect = useCallback((id: string) => {
    setActiveTaskId(id)
    dispatch(setCurrentSession(id))
    onTaskSelect?.(id)
    // 压入导航历史（与当前位置相同则不重复压栈）
    setNavHistory((h) => {
      const current = h[navIndexRef.current] ?? ''
      if (current === id) return h
      const trimmed = h.slice(0, navIndexRef.current + 1)
      const next = [...trimmed, id]
      navIndexRef.current = next.length - 1
      setNavIndex(next.length - 1)
      return next
    })
  }, [dispatch, onTaskSelect])

  const handleNewTask = useCallback(() => {
    setActiveTaskId(null)
    dispatch(setCurrentSession(''))
    onNewTask?.()
    setNavHistory((h) => {
      const trimmed = h.slice(0, navIndexRef.current + 1)
      if (trimmed[trimmed.length - 1] === '') return h
      const next = [...trimmed, '']
      navIndexRef.current = next.length - 1
      setNavIndex(next.length - 1)
      return next
    })
  }, [dispatch, onNewTask])

  // 后退/前进：只移动索引指针，不产生新历史。目标为空串 → 回新任务首页。
  const goToHistory = useCallback((targetIndex: number) => {
    setNavHistory((h) => {
      if (targetIndex < 0 || targetIndex >= h.length) return h
      navIndexRef.current = targetIndex
      setNavIndex(targetIndex)
      const id = h[targetIndex]
      if (id) {
        setActiveTaskId(id)
        dispatch(setCurrentSession(id))
        onTaskSelect?.(id)
      } else {
        setActiveTaskId(null)
        dispatch(setCurrentSession(''))
        onNewTask?.()
      }
      return h
    })
  }, [dispatch, onNewTask, onTaskSelect])
  const canBack = navIndex > 0
  const canForward = navIndex < navHistory.length - 1
  const handleBack = useCallback(() => goToHistory(navIndexRef.current - 1), [goToHistory])
  const handleForward = useCallback(() => goToHistory(navIndexRef.current + 1), [goToHistory])

  // 工作区切换（窗口菜单「打开工作区」/ 侧栏「添加项目」）：picker → 持久化 →
  // 通知各消费者重新发现工作区根（getWorkspaceRoot 是唯一真源）。
  const handleWorkspaceChanged = useCallback(() => {
    setWorkspaceEpoch((e) => e + 1)
  }, [])
  useEffect(() => {
    window.addEventListener('khy:workspace-changed', handleWorkspaceChanged)
    return () => window.removeEventListener('khy:workspace-changed', handleWorkspaceChanged)
  }, [handleWorkspaceChanged])

  // 消息流内「查看文件」/ 空态快捷入口等 → 统一走 side-pane 的 codeViewer 标签
  // （与磁贴、侧栏文件树、命令面板「打开文件」同一条路径）
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (typeof detail === 'string' && detail) openFileTab(detail)
    }
    window.addEventListener('khy:open-file', onOpenFile)
    return () => window.removeEventListener('khy:open-file', onOpenFile)
  }, [openFileTab])

  // 外部编辑器未配置时的回落入口（AppHeader 派发）→ 打开「打开文件」选择器，
  // 用户从工作区选文件进内置编辑器。不再是报错死路。
  useEffect(() => {
    const onOpenPicker = () => openPaneTab('openFile')
    window.addEventListener('khy:open-file-picker', onOpenPicker)
    return () => window.removeEventListener('khy:open-file-picker', onOpenPicker)
  }, [openPaneTab])

  // ── 会话列表加载（带自动重试 + 手动重试）─────────────────────────
  //
  // 旧实现是「挂载时拉一次，失败就摆错误态」：一次失败 = 整个侧栏死掉，
  // 没有重试、没有重试入口，用户只能重启应用（实测：总是加载失败）。
  // 现在：
  //   · 失败后按 SESSION_LIST_RETRY_DELAYS_MS 自动重试（3 次，退避递增）
  //   · 错误态给「重试」按钮（onReloadTasks → 手动重来一次）
  //   · 刷新失败时**保留上一次的好列表**，不清空已知内容
  const loadTasks = useCallback((attempt: number) => {
    const api = (window as unknown as {
      __KHYOS__?: { listSessions?: (limit?: number) => Promise<{ ok: boolean; sessions?: RealSession[]; error?: string }> }
    }).__KHYOS__
    if (!api?.listSessions) {
      setSessionError('会话列表不可用：preload 未注入 __KHYOS__，请重启应用')
      setSessionLoading(false)
      return
    }
    setSessionLoading(true)
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(safetyTimer)
      fn()
    }
    // 安全网：preload 的 IPC 没有自带超时，host 挂死时 promise 永不 settle。
    const safetyTimer = window.setTimeout(() => {
      settle(() => {
        setSessionLoading(false)
        setSessionError('会话列表读取超时：host 进程 25 秒无响应，请点「重试」重试')
        scheduleRetry(attempt)
      })
    }, SESSION_LIST_TIMEOUT_MS)

    const scheduleRetry = (failedAttempt: number) => {
      const delay = nextRetryDelay(failedAttempt)
      if (delay === null) return
      attemptRef.current = failedAttempt + 1
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        loadTasksRef.current(failedAttempt + 1)
      }, delay)
    }

    api.listSessions(50).then((res) => {
      settle(() => {
        setSessionLoading(false)
        const list = res?.sessions || []
        const mapped: WorkspaceSidebarTask[] = list.map((s) => ({
          id: s.sessionId,
          title: resolveSessionTitle(s),
          // cwd 缺失时**不要**退化到 projectDir：它是会话文件的桶目录
          // （sessionPersistence 里 path.dirname(file)，形如 `D--Portable-khy-os`），
          // 拿它当项目等于把存储结构显示成"项目"。空 cwd 一律进「未归属」。
          // 实测 708 个快照里 412 个没有 metadata.cwd（多为 .archive 下的 trace-chain）。
          workspacePath: s.cwd || '',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          archived: false,
        }))
        if (mapped.length > 0) {
          setTasks(mapped)
          setActiveTaskId((prev) => prev || mapped[0].id)
          if (!activeTaskIdRef2.current) dispatch(setCurrentSession(mapped[0].id))
        }
        if (!res?.ok) {
          setSessionError(res?.error || '会话列表读取失败：host 进程无响应')
          scheduleRetry(attempt)
        } else {
          setSessionError('')
        }
      })
    }).catch(() => {
      settle(() => {
        setSessionLoading(false)
        setSessionError('会话列表读取失败：host 进程无响应，请点「重试」重试')
        scheduleRetry(attempt)
      })
    })
  }, [dispatch])

  useEffect(() => {
    loadTasksRef.current = loadTasks
  }, [loadTasks])

  // 手动重试：把尝试次数归零，立刻重来一次（不等自动退避）。
  const reloadTasks = useCallback(() => {
    attemptRef.current = 0
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    loadTasksRef.current(0)
  }, [])

  useEffect(() => {
    loadTasksRef.current(0)
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
    }
  }, [])

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar
        onToggleSidebar={toggleSidebar}
        sidebarVisible={sidebarVisible}
        onToggleSidePane={toggleSidePane}
        sidePaneVisible={sidePaneVisible}
        onToggleTerminal={toggleTerminal}
        sessionTitle={sessionTitle}
        onNewTask={handleNewTask}
        onReloadSession={onReloadSession}
        onBack={handleBack}
        onForward={handleForward}
        canBack={canBack}
        canForward={canForward}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* ZCode has no narrow icon rail: one wide task panel (330px default,
            drag resizable) + main + side pane (ZC-ALIGN-002 A2/A5). */}
        {sidebarVisible && (
          <>
            <WorkspaceSidebar
              tasks={tasks}
              sessionError={sessionError}
              sessionLoading={sessionLoading}
              onReloadTasks={reloadTasks}
              activeTaskId={activeTaskId}
              onTaskSelect={handleTaskSelect}
              onNewTask={handleNewTask}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              width={sidebar.width}
              onOpenFile={openFileTab}
              workspaceEpoch={workspaceEpoch}
            />
            {/* 右缘拖拽条（workspaceSidebar.resizeSidebar）— 4px 热区 + hover 高亮握把，
                双击恢复默认宽。加宽命中区让「悬浮选中调整」更易触发。
                常态色用 border-strong：面板分界本来只有 1px 弱边框，拖拽条
                常态可见才谈得上「可拖」。握把（grip）hover 才显形 —— 4px 竖线
                本身没有任何「这里能拖」的视觉线索。 */}
            <div
              onPointerDown={(e) => sidebar.startDrag(e, 1)}
              onDoubleClick={() => sidebar.resize(SIDEBAR_WIDTH.default)}
              className={`group relative w-[4px] shrink-0 cursor-col-resize bg-border-strong transition-colors hover:bg-brand/70 active:bg-brand ${sidebar.dragging ? 'bg-brand' : ''}`}
              title="拖拽调整侧边栏宽度（双击恢复默认）"
              aria-label="调整侧边栏宽度"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </div>
          </>
        )}
        <main className="khy-brand-main flex-1 overflow-auto flex flex-col">{children}</main>
        {/* 左缘拖拽条（sidePane.restoreSize；双击恢复默认宽）。SidePane 本身
            始终挂载——其 Ctrl+Alt+B / Ctrl+J 快捷键注册在 visible 闸门之前，
            条件挂载会让隐藏态丢快捷键 */}
        {sidePaneVisible && (
          <div
            onPointerDown={(e) => sidePaneSize.startDrag(e, -1)}
            onDoubleClick={() => sidePaneSize.resize(SIDEPANE_WIDTH.default)}
            className={`group relative w-[4px] shrink-0 cursor-col-resize bg-border-strong transition-colors hover:bg-brand/70 active:bg-brand ${sidePaneSize.dragging ? 'bg-brand' : ''}`}
            title="拖拽调整面板宽度（双击恢复默认）"
            aria-label="调整面板宽度"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </div>
        )}
        <SidePane
          visible={sidePaneVisible}
          tabs={paneTabs}
          activeTabId={activePaneTabId}
          hasSessions={tasks.length > 0}
          width={sidePaneSize.width}
          onOpenTab={openPaneTab}
          onOpenFile={openFileTab}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
          onFileDirty={handleFileDirty}
          onToggle={toggleSidePane}
          onClose={handleSidePaneClose}
        />
        {/* 未保存更改确认（内置编辑器）：取消 = 留在原标签；放弃更改 = 继续
            关闭/切换。Ctrl+S 的提示写在正文里 —— 拦截的目的就是让人来得及保存。 */}
        {pendingUnsaved && (
          <>
            <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setPendingUnsaved(null)} />
            <div
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[400px] rounded-lg border border-border bg-popover shadow-2xl"
              role="dialog"
              aria-label="未保存更改"
            >
              <div className="px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">未保存更改</h2>
              </div>
              <div className="px-4 py-4 space-y-3">
                <p className="text-sm text-foreground leading-relaxed">
                  {(() => {
                    const tab = paneTabs.find((t) => t.id === pendingUnsaved.tabId)
                    return `「${tab?.title || '当前文件'}」有未保存的更改。`
                  })()}
                </p>
                <p className="text-xs text-foreground-muted leading-relaxed">
                  按 Ctrl+S 可先保存；放弃更改将丢失自上次保存以来的修改。
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
                <button
                  onClick={() => setPendingUnsaved(null)}
                  className="px-3 py-1.5 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    const action = pendingUnsaved
                    setPendingUnsaved(null)
                    if (!action) return
                    // 先清脏点再执行：不清的话 closeTabNow 之后的脏检查
                    // （或编辑器卸载前的最后一次回调）会把确认框再拉起来。
                    const tab = paneTabs.find((t) => t.id === action.tabId)
                    if (tab?.filePath) handleFileDirty(tab.filePath, false)
                    if (action.kind === 'close') {
                      closeTabNow(action.tabId)
                    } else {
                      setActivePaneTabId(action.nextId)
                    }
                  }}
                  className="px-3 py-1.5 rounded-md text-xs bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                >
                  放弃更改并继续
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {/* No bottom status bar: real ZCode keeps account/remote/settings in the
          sidebar footer (ZC-ALIGN-002 C 区); model/mode/usage live in the
          Composer tool row (E5b).
          剥洋葱 · 视觉侧第三刀：命令面板按需加载 —— 条件渲染 + Suspense。 */}
      {commandCenterOpen && (
        <Suspense fallback={null}>
          <CommandCenter
            visible={commandCenterOpen}
            onClose={onCommandCenterClose}
            onPanelAction={handlePanelAction}
            // 会话状态的主人是本组件：新建任务要连 activeTaskId 与导航历史一起重置，
            // 只清消息是不够的。所以面板的「新建任务」接到 handleNewTask，而不是 App
            // 层的 handleNewTask（[DESIGN-ARCH-125] P-03）。
            onNewTask={handleNewTask}
            onReloadSession={onReloadSession}
          />
        </Suspense>
      )}
      {/* 桌宠：Lucky 主题的悬浮卡片。左下角、可拖拽、可收起；z-40 在正文之上、
          弹层（z-50）之下；卡片本身是唯一命中区，不抢工作区的任何点击。 */}
      <KhyPet />
    </div>
  )
}

// Task shape consumed by WorkspaceSidebar (subset of the slice interface).
interface WorkspaceSidebarTask {
  id: string
  title: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  archived: boolean
}
