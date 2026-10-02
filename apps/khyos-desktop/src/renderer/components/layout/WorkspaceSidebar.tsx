import { useState, useMemo, useEffect, useRef } from 'react'
import { useAppDispatch } from '../../state/store'
import { addToast } from '../../state/toastSlice'
import { FileTree } from '../filetree/FileTree'

// Local-mode account display name. Real ZCode shows the logged-in username
// here; the shell is local-first, so a neutral name until login lands in
// Settings → 账号 (login.* keys).
const ACCOUNT_NAME = '本地用户'

// 界面主题 / 界面缩放档位（账户菜单子菜单，对齐 ZCode C1 实测：
// 系统默认/深色主题✓/浅色主题 + 缩放三档）。值取自 theme.ts 的 mode 枚举与
// main zoom:set 的 0.5–2.0 夹紧区间。
const THEME_OPTIONS: { id: string; label: string }[] = [
  { id: 'system', label: '系统默认' },
  { id: 'dark', label: '深色主题' },
  { id: 'light', label: '浅色主题' },
]
const ZOOM_OPTIONS: { factor: number; label: string }[] = [
  { factor: 0.9, label: '缩小' },
  { factor: 1, label: '实际大小' },
  { factor: 1.1, label: '放大' },
]

// Sidebar views (workspaceFileTree.*): the file tree is a
// view INSIDE the task sidebar (ZCode truth), not a separate panel — the task row's
// 查看文件 switches in, 返回任务 switches back.
type SidebarView = 'tasks' | 'fileTree'

interface Task {
  id: string
  title: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  archived: boolean
}

interface WorkspaceSidebarProps {
  tasks: Task[]
  archivedTasks?: Task[]
  activeTaskId: string | null
  onTaskSelect: (id: string) => void
  onNewTask: () => void
  viewMode: 'grouped' | 'chronological'
  onViewModeChange: (mode: 'grouped' | 'chronological') => void
  searchQuery: string
  onSearchChange: (query: string) => void
  // Error surfaced by the host bridge when the real session list could not
  // be read (host down / KHY_OS_DIR misconfigured). Shown instead of the
  // generic empty state so the user knows why the list is blank.
  sessionError?: string
  // Panel width in px (drag-resizable, owned by AppLayout via usePanelWidth)
  width?: number
  // File-tree view: file click → AppLayout openFileTab (codeViewer tab)
  onOpenFile?: (filePath: string) => void
  // 工作区切换纪元：变化时重挂载文件树（换根后必须重新拉树）
  workspaceEpoch?: number
}

export function WorkspaceSidebar({
  tasks,
  archivedTasks = [],
  activeTaskId,
  onTaskSelect,
  onNewTask,
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  sessionError = '',
  width,
  onOpenFile,
  workspaceEpoch = 0,
}: WorkspaceSidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [sortBy, setSortBy] = useState<'updatedAt' | 'createdAt'>('updatedAt')
  // 'fileTree' = workspaceFileTree view, entered from a task row's 查看文件; 'tasks' = backToTasks
  const [view, setView] = useState<SidebarView>('tasks')
  // 账户菜单（ZCode C1：头像 chip has_menu 展开）— 展开态 + 子菜单展开键
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [accountSubmenu, setAccountSubmenu] = useState<'theme' | 'zoom' | 'locale' | null>(null)
  const [themeMode, setThemeMode] = useState('system')
  const accountMenuRef = useRef<HTMLDivElement>(null)
  // 任务行三点菜单：当前展开的行 id（ZCode 真源 B7 的行级操作，复刻为 ⋮ 子菜单）
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)
  // 文件树根目录：null = 主进程 cwd 工作区（顶部导航「查看文件」行为）；
  // 会话级目录 = 会话三点菜单「查看文件」触发时该 session 的 workspacePath
  const [fileTreeRoot, setFileTreeRoot] = useState<string | null>(null)
  const dispatch = useAppDispatch()

  // ── Manual sidebar order (long-press left-drag reorder) ───────────────────
  // The host bridge exposes no reorder API, so the manual order is persisted
  // renderer-side in localStorage (a UI preference). Sessions not in the
  // stored order fall through to the sortBy fallback.
  const ORDER_KEY = 'khy.sidebar.taskOrder'
  const [taskOrder, setTaskOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]') } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(taskOrder)) } catch { /* private mode */ }
  }, [taskOrder])

  const orderIndex = useMemo(() => {
    const m = new Map<string, number>()
    taskOrder.forEach((id, i) => m.set(id, i))
    return m
  }, [taskOrder])

  // Drag state. Press left button on a row, move >5px → drag (live reorder);
  // release without moving → a normal click selects the task. No long-press
  // delay: desktop drag should feel instant. suppressedClickRef holds the id
  // whose click must be swallowed right after a drag so it doesn't also select.
  const dragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null)
  const suppressedClickRef = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState(-1)
  // 拖拽归组:分组视图下,卡片悬停到某个文件夹头上时记录其 key('group:<id>' |
  // 'ungrouped'),松手即归入/移出该分组。ref 与 state 成对:闭包读 ref,渲染读 state。
  const [dropFolderKey, setDropFolderKey] = useState<string | null>(null)
  const dropFolderRef = useRef<string | null>(null)

  // Tasks in the manual order (orderIndex first, then sortBy, then id), so the
  // sidebar reflects the user's drag arrangement. Filtering by search still
  // applies on top.
  const orderedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const ia = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const ib = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (ia !== ib) return ia - ib
      return b[sortBy] - a[sortBy]
    })
  }, [tasks, orderIndex, sortBy])

  const filteredOrdered = useMemo(() => {
    let result = orderedTasks
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(t => t.title.toLowerCase().includes(q))
    }
    return result
  }, [orderedTasks, searchQuery])

  // Pointer handlers for drag reorder (attached to each row).
  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragRef.current = { id, startY: e.clientY, moved: false }
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current
      if (!cur) return
      if (Math.abs(ev.clientY - cur.startY) > 5) {
        if (!cur.moved) {
          cur.moved = true
          setDragId(id)
        }
        // 分组视图:先做文件夹头命中测试 —— 指针悬在某个分组头(或「未分组」)上时
        // 进入「归组」模式,清掉行落点指示,松手改归属而不是改顺序。
        if (viewMode === 'grouped') {
          const headers = Array.from(document.querySelectorAll('[data-folder-key]')) as HTMLElement[]
          let hoverKey: string | null = null
          for (const h of headers) {
            const r = h.getBoundingClientRect()
            if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
              hoverKey = h.getAttribute('data-folder-key')
              break
            }
          }
          if (hoverKey) {
            dropFolderRef.current = hoverKey
            setDropFolderKey(hoverKey)
            setOverIndex(-1)
            return
          }
        }
        dropFolderRef.current = null
        setDropFolderKey(null)
        // Compute target index from the rendered rows' positions.
        const rows = Array.from(document.querySelectorAll('[data-row-id]')) as HTMLElement[]
        let target = rows.length
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect()
          if (ev.clientY < r.top + r.height / 2) { target = i; break }
        }
        setOverIndex(target)
        // Live reorder: move the dragged id to the target slot in taskOrder.
        setTaskOrder(prev => {
          const list = prev.length ? prev : orderedTasks.map(t => t.id)
          const from = list.indexOf(id)
          if (from === -1) return prev
          let to = target
          if (to > from) to -= 1
          if (to === from || to < 0 || to > list.length) return prev
          const next = list.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return next
        })
      }
    }
    const onUp = () => {
      const cur = dragRef.current
      const targetFolder = dropFolderRef.current
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (cur && cur.moved) {
        // Swallow the click that follows so the row's onClick doesn't select.
        suppressedClickRef.current = cur.id
        if (targetFolder) {
          // 落在分组头上 → 改归属:group:<id> 归入该分组,'ungrouped' 移出分组。
          if (targetFolder === 'ungrouped') {
            moveTaskToGroup(cur.id, null)
            toast('已移出分组，归入「未分组」')
          } else if (targetFolder.startsWith('group:')) {
            const gid = targetFolder.slice('group:'.length)
            const g = groups.find(x => x.id === gid)
            moveTaskToGroup(cur.id, gid)
            toast(g ? `已移入分组「${g.name}」` : '已移入分组')
          }
        }
      }
      dragRef.current = null
      dropFolderRef.current = null
      setDragId(null)
      setOverIndex(-1)
      setDropFolderKey(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onRowClick = (id: string) => {
    if (suppressedClickRef.current === id) {
      suppressedClickRef.current = null
      return
    }
    onTaskSelect(id)
  }

  // ── 视图分组:项目 tab 按 workspacePath 自动分文件夹;分组 tab 用自建分组 ────
  // 此前 项目/分组 两个 tab 只是高亮切换,渲染完全不分叉(ZC 缺陷:切换无差别)。
  // 宿主桥没有 group API,分组与归属关系持久化在 renderer localStorage。
  const GROUPS_KEY = 'khy.sidebar.groups'
  const TASK_GROUP_KEY = 'khy.sidebar.taskGroup'
  type SidebarGroup = { id: string; name: string; sortOrder: number }
  const [groups, setGroups] = useState<SidebarGroup[]>(() => {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]') } catch { return [] }
  })
  const [taskGroup, setTaskGroup] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(TASK_GROUP_KEY) || '{}') } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)) } catch { /* 私有模式 */ }
  }, [groups])
  useEffect(() => {
    try { localStorage.setItem(TASK_GROUP_KEY, JSON.stringify(taskGroup)) } catch { /* 私有模式 */ }
  }, [taskGroup])

  // 折叠的文件夹 key 集合(内存态,默认全展开)
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set())
  const toggleFolder = (key: string) =>
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // 新建/重命名分组的小对话框(Electron 渲染层没有 window.prompt)
  const [groupDialog, setGroupDialog] = useState<{ mode: 'create' | 'rename'; groupId?: string; value: string } | null>(null)
  const confirmGroupDialog = () => {
    if (!groupDialog) return
    const name = groupDialog.value.trim()
    if (name) {
      if (groupDialog.mode === 'create') {
        setGroups(prev => [...prev, { id: `g_${Date.now()}`, name, sortOrder: prev.length }])
        toast(`已创建分组「${name}」`)
      } else if (groupDialog.groupId) {
        setGroups(prev => prev.map(g => (g.id === groupDialog.groupId ? { ...g, name } : g)))
        toast('已重命名分组')
      }
    }
    setGroupDialog(null)
  }
  const deleteGroup = (g: SidebarGroup) => {
    setGroups(prev => prev.filter(x => x.id !== g.id))
    // 组内会话回落「未分组」,绝不随之消失(与 web 端 removeGroup 语义一致)
    setTaskGroup(prev => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) if (v !== g.id) next[k] = v
      return next
    })
    toast(`已删除分组「${g.name}」,组内会话移入「未分组」`)
  }
  const moveTaskToGroup = (taskId: string, groupId: string | null) => {
    setTaskGroup(prev => {
      const next = { ...prev }
      if (groupId == null) delete next[taskId]
      else next[taskId] = groupId
      return next
    })
  }

  // workspacePath → 文件夹显示名(取路径末段)
  const baseName = (p: string) => {
    const seg = p.split(/[\\/]/).filter(Boolean)
    return seg.length ? seg[seg.length - 1] : p
  }

  interface SidebarFolder {
    key: string
    kind: 'project' | 'group' | 'unassigned' | 'ungrouped'
    name: string
    items: Task[]
    groupRef?: SidebarGroup
  }

  // 两个 tab 的文件夹化视图:数据源同为 filteredOrdered(已含手动排序 + 搜索过滤),
  // 分桶维度不同 —— 项目 tab 派生自 workspacePath,分组 tab 派生自自建分组。
  const folders = useMemo<SidebarFolder[]>(() => {
    if (viewMode === 'grouped') {
      const byGroup = new Map<string, Task[]>()
      const ungrouped: Task[] = []
      for (const t of filteredOrdered) {
        const gid = taskGroup[t.id]
        if (gid && groups.some(g => g.id === gid)) {
          const arr = byGroup.get(gid) || []
          arr.push(t)
          byGroup.set(gid, arr)
        } else {
          ungrouped.push(t)
        }
      }
      const out: SidebarFolder[] = [...groups]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map(g => ({ key: `group:${g.id}`, kind: 'group' as const, name: g.name, items: byGroup.get(g.id) || [], groupRef: g }))
      if (ungrouped.length) out.push({ key: 'ungrouped', kind: 'ungrouped', name: '未分组', items: ungrouped })
      return out
    }
    // 项目视图:按 workspacePath 分文件夹,零新数据模型
    const byPath = new Map<string, Task[]>()
    for (const t of filteredOrdered) {
      const p = t.workspacePath || ''
      const arr = byPath.get(p) || []
      arr.push(t)
      byPath.set(p, arr)
    }
    return [...byPath.entries()]
      .map(([p, items]) => ({
        key: `project:${p || 'none'}`,
        kind: (p ? 'project' : 'unassigned') as 'project' | 'unassigned',
        name: p ? baseName(p) : '未归属项目',
        items,
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'unassigned' ? 1 : -1
        // items 已按手动序/时间排好,首项即最近活跃
        return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0)
      })
  }, [viewMode, filteredOrdered, groups, taskGroup])

  // 拖拽落点指示线用的扁平行号(文件夹化后行仍渲染一次,行号 = filteredOrdered 下标)
  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>()
    filteredOrdered.forEach((t, i) => m.set(t.id, i))
    return m
  }, [filteredOrdered])

  useEffect(() => {
    const api = (window as unknown as { __KHYOS__?: { getTheme?: () => Promise<string> } }).__KHYOS__
    void api?.getTheme?.().then((m) => { if (typeof m === 'string' && m) setThemeMode(m) }).catch(() => {})
  }, [])

  // 账户菜单外点 / Escape 关闭（对齐其它自绘下拉的交互）
  useEffect(() => {
    if (!accountMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false)
        setAccountSubmenu(null)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setAccountMenuOpen(false); setAccountSubmenu(null) }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [accountMenuOpen])

  // 任务行三点菜单外点 / Escape 关闭：用 data-task-menu 属性判定命中，
  // 避免多行各自挂载菜单时的 ref 竞争（切行时旧菜单卸载/新菜单挂载顺序不定）
  useEffect(() => {
    if (!taskMenuId) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || !target.closest('[data-task-menu]')) setTaskMenuId(null)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTaskMenuId(null)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [taskMenuId])

  const toast = (title: string, type: 'info' | 'error' = 'info') => dispatch(addToast({ type, title }))

  // 界面主题子菜单：写 settings + 立刻应用 DOM class（theme:set 会广播到所有窗口）
  const applyTheme = (mode: string) => {
    const api = (window as unknown as { __KHYOS__?: { setTheme?: (m: string) => Promise<boolean> } }).__KHYOS__
    setThemeMode(mode)
    void api?.setTheme?.(mode).catch(() => toast('主题保存失败：请重启应用后重试', 'error'))
    setAccountMenuOpen(false)
    setAccountSubmenu(null)
  }

  // 界面缩放子菜单：main 侧 setZoomFactor（0.5–2.0 夹紧），立即生效
  const applyZoom = (factor: number) => {
    const api = (window as unknown as { __KHYOS__?: { setZoomFactor?: (f: number) => Promise<number> } }).__KHYOS__
    void api?.setZoomFactor?.(factor).then((applied) => {
      toast(`界面缩放已设为 ${Math.round((applied ?? factor) * 100)}%`)
    }).catch(() => toast('界面缩放设置失败：请重启应用后重试', 'error'))
    setAccountMenuOpen(false)
    setAccountSubmenu(null)
  }

  // 任务行三点菜单「查看文件」（taskList.showFiles）：切到文件树视图，
  // 以该会话的 workspacePath 为树根；会话没有独立工作区时回退主进程 cwd 工作区
  const viewTaskFiles = (task: Task) => {
    setFileTreeRoot(task.workspacePath || null)
    setTaskMenuId(null)
    setView('fileTree')
  }

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return `${Math.floor(diff / 86400000)} 天前`
  }

  // filteredTasks was folded into filteredOrdered above (manual order aware);
  // this block removed to avoid an unused memo.

  const sortedArchived = useMemo(() => {
    return [...archivedTasks].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [archivedTasks])

  return (
    <div
      className="bg-sidebar border-r border-border flex flex-col h-full overflow-hidden relative"
      style={width ? { width: `${width}px` } : undefined}
    >
      {view === 'fileTree' ? (
        <>
          {/* 文件树视图头：返回任务（workspaceFileTree.backToTasks）+ Workspace
              标题由 FileTree 头部渲染；这里只留顶部切换条 */}
          <div className="px-2.5 pt-3 pb-2 flex items-center gap-2">
            <button
              onClick={() => setView('tasks')}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover transition-colors"
              title="返回任务"
              aria-label="返回任务"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
                <path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>返回任务</span>
            </button>
          </div>
          {/* 树体占满剩余高度；文件点击 → 上层 codeViewer 标签。key 绑定工作区
              纪元 + 树根：换工作区或从会话三点菜单进文件树（根不同）时重挂载，
              按新根重新拉树 */}
          <div className="flex-1 overflow-hidden">
            <FileTree
              key={`${workspaceEpoch}:${fileTreeRoot || 'workspace'}`}
              onOpenFile={onOpenFile || (() => {})}
              rootPath={fileTreeRoot || undefined}
            />
          </div>
        </>
      ) : (
      <>
      {/* 顶部导航区 — mirrors ZCode B1-B4: 新建任务 Ctrl+N / 搜索 Ctrl+K /
          自动化 / 插件市场, full-width 40px rows (ZC-ALIGN-002 实测) */}
      <div className="px-2.5 pt-3 pb-1 flex flex-col gap-0.5">
        <button
          onClick={onNewTask}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0">
            <circle cx="7.5" cy="7.5" r="5.8" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7.5 5v5M5 7.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="flex-1">新建任务</span>
          <span className="text-xs text-foreground/40">Ctrl+N</span>
        </button>
        <button
          onClick={() => window.dispatchEvent(new Event('khy:open-command-center'))}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0">
            <circle cx="6.6" cy="6.6" r="4.6" stroke="currentColor" strokeWidth="1.2" />
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="flex-1">搜索</span>
          <span className="text-xs text-foreground/40">Ctrl+K</span>
        </button>
        <button
          onClick={() => { window.location.hash = '#/automations' }}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0">
            <circle cx="7.5" cy="7.5" r="2.2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7.5 1.5v2M7.5 11.5v2M1.5 7.5h2M11.5 7.5h2M3.3 3.3l1.4 1.4M10.3 10.3l1.4 1.4M11.7 3.3l-1.4 1.4M4.7 10.3l-1.4 1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="flex-1">自动化</span>
        </button>
        <button
          onClick={() => { window.location.hash = '#/settings/plugins' }}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0">
            <rect x="2" y="2" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2 5.5h11M5.5 5.5V13" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          <span className="flex-1">插件市场</span>
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="px-2.5 pb-2 border-b border-border">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="搜索任务..."
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-input-border-focused focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-foreground/50 hover:text-foreground text-sm font-bold"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 视图切换 + 排序 — ZCode 实测 tab 为「项目/分组」（a329/a330），
          复刻原为「分组/时间线」，对齐真源（P3-2，第八轮 2026-09-13） */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <button
          onClick={() => onViewModeChange('chronological')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'chronological'
              ? 'bg-selected text-foreground'
              : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          项目
        </button>
        <button
          onClick={() => onViewModeChange('grouped')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'grouped'
              ? 'bg-selected text-foreground'
              : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          分组
        </button>
        <div className="flex-1" />
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as 'updatedAt' | 'createdAt')}
          className="text-xs bg-input border border-input-border rounded-md px-2 py-1 text-foreground/60 focus:outline-none"
        >
          <option value="updatedAt">更新时间</option>
          <option value="createdAt">创建时间</option>
        </select>
      </div>

      {/* 任务列表 */}
      <div
        className={`flex-1 overflow-auto p-2 ${dragId !== null ? 'select-none' : ''}`}
        style={dragId !== null ? { cursor: 'grabbing' } : undefined}
      >
        {sessionError && tasks.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground/50 text-sm py-12 px-4 text-center">
            <span className="text-3xl mb-3">⚠</span>
            <span className="font-medium text-foreground/70">会话列表读取失败</span>
            <span className="text-xs text-foreground/40 mt-1.5 leading-relaxed">{sessionError}</span>
          </div>
        ) : filteredOrdered.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground/50 text-sm py-12">
            <span className="text-3xl mb-3">□</span>
            <span className="font-medium">还没有任务</span>
            <span className="text-xs text-foreground/30 mt-1">点击上方「新建任务」或 Ctrl+N 创建新任务</span>
          </div>
        ) : filteredOrdered.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground/50 text-sm py-12">
            <span className="text-3xl mb-3">⌕</span>
            <span className="font-medium">没有匹配的任务</span>
            <span className="text-xs text-foreground/30 mt-1">尝试其他搜索词</span>
          </div>
        ) : (
          <div className="space-y-1">
            {/* 视图节头:标题随 tab 变化(项目/分组);收起按钮必须留在可见区，
                否则收起后无法再展开（此前整块包在 !collapsed 里 = 折叠即死路） */}
            <div className="px-3 py-1.5 text-xs font-semibold text-foreground/50 uppercase tracking-wider flex items-center justify-between">
              <span>{viewMode === 'grouped' ? '分组' : '项目'}</span>
              <div className="flex items-center gap-0.5">
                {viewMode === 'grouped' && (
                  <button
                    onClick={() => setGroupDialog({ mode: 'create', value: '' })}
                    className="text-foreground/30 hover:text-foreground px-1 text-sm leading-none"
                    title="新建分组"
                    aria-label="新建分组"
                  >
                    ＋
                  </button>
                )}
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="text-foreground/30 hover:text-foreground px-1"
                  title={collapsed ? '展开列表' : '收起列表'}
                  aria-label={collapsed ? '展开列表' : '收起列表'}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? '▸' : '▾'}
                </button>
              </div>
            </div>
            {!collapsed && folders.map(folder => {
              const folderCollapsed = collapsedFolders.has(folder.key)
              const folderMenuOpen = taskMenuId === folder.key
              return (
                <div key={folder.key}>
                  {/* 文件夹头:折叠切换;分组文件夹另有 ⋮ 菜单(重命名/删除)。
                      data-task-menu 复用行菜单的外点关闭 effect(文件夹 key 以
                      group:/project: 开头,与任务 id 不冲突)。data-folder-key 供
                      拖拽归组的头命中测试;拖拽悬停时高亮提示「可松手归入」 */}
                  <div
                    className={`group/f relative flex items-center gap-1.5 px-2.5 py-1 mt-0.5 rounded-md text-xs font-medium text-foreground/60 cursor-pointer select-none hover:bg-surface-hover hover:text-foreground transition-colors ${
                      dragId !== null && dropFolderKey === folder.key
                        ? 'ring-1 ring-brand bg-brand/10 text-foreground'
                        : ''
                    }`}
                    role="button"
                    tabIndex={0}
                    data-task-menu
                    data-folder-key={folder.key}
                    onClick={() => toggleFolder(folder.key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleFolder(folder.key)
                      }
                    }}
                    aria-expanded={!folderCollapsed}
                  >
                    <span className="text-foreground/30 w-2 flex-shrink-0">{folderCollapsed ? '▸' : '▾'}</span>
                    <span className="truncate flex-1 text-left">{folder.name}</span>
                    <span className="text-foreground/30 flex-shrink-0">{folder.items.length}</span>
                    {folder.kind === 'group' && folder.groupRef && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setTaskMenuId(folderMenuOpen ? null : folder.key)
                        }}
                        className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                          folderMenuOpen
                            ? 'opacity-100 bg-surface-hover text-foreground'
                            : 'opacity-0 group-hover/f:opacity-100 text-foreground/50 hover:text-foreground'
                        }`}
                        title="分组操作"
                        aria-label={`分组操作 ${folder.name}`}
                        aria-haspopup="menu"
                        aria-expanded={folderMenuOpen}
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                          <circle cx="6" cy="2" r="1.1" />
                          <circle cx="6" cy="6" r="1.1" />
                          <circle cx="6" cy="10" r="1.1" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {folder.kind === 'group' && folder.groupRef && folderMenuOpen && (
                    <div
                      role="menu"
                      className="ml-6 mt-0.5 mb-1 w-36 py-1 rounded-lg border border-border bg-popover shadow-2xl text-sm z-50"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setGroupDialog({ mode: 'rename', groupId: folder.groupRef!.id, value: folder.groupRef!.name })
                          setTaskMenuId(null)
                        }}
                        className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                      >
                        重命名分组
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          deleteGroup(folder.groupRef!)
                          setTaskMenuId(null)
                        }}
                        className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                      >
                        删除分组
                      </button>
                    </div>
                  )}
                  {!folderCollapsed && folder.items.map(task => {
                    const menuOpen = taskMenuId === task.id
                    const isDragging = dragId === task.id
                    const rowIdx = rowIndexById.get(task.id) ?? -1
                    const showDropBefore = dragId !== null && overIndex === rowIdx && !isDragging
                    const currentGroupId = taskGroup[task.id] || null
                    return (
                      <div
                        key={task.id}
                        className="group relative"
                        data-task-menu
                        data-row-id={task.id}
                        onPointerDown={(e) => onRowPointerDown(e, task.id)}
                        style={{
                          opacity: isDragging ? 0.4 : undefined,
                          transform: isDragging ? 'scale(0.99)' : undefined,
                          boxShadow: isDragging ? '0 2px 8px rgba(0,0,0,0.18)' : undefined,
                          cursor: dragId ? 'grabbing' : undefined,
                          transition: 'opacity 0.12s, transform 0.12s',
                        }}
                      >
                        {/* Drop indicator line above this row while dragging. */}
                        {showDropBefore && (
                          <div className="h-0.5 -mx-1 mb-0.5 rounded-full bg-brand/70" />
                        )}
                        <button
                          onClick={() => onRowClick(task.id)}
                          className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                            activeTaskId === task.id
                              ? 'bg-selected text-foreground ring-1 ring-brand/20'
                              : 'text-foreground/80 hover:bg-surface-hover hover:text-foreground'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 pr-8">
                            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                              activeTaskId === task.id ? 'bg-brand' : 'bg-foreground/20'
                            }`} />
                            <span className="text-sm font-medium truncate flex-1">{task.title}</span>
                          </div>
                          <div className="text-xs text-foreground/40 mt-1 pl-5">
                            {formatTime(task.updatedAt)}
                          </div>
                        </button>

                        {/* 三点（⋮）触发钮：hover 行时淡入（ZCode 真源 B7 行级操作复刻）。
                            菜单含「查看文件」；分组 tab 追加 移入/移出分组 */}
                        <button
                          type="button"
                          onClick={() => setTaskMenuId(menuOpen ? null : task.id)}
                          className={`absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                            menuOpen
                              ? 'opacity-100 bg-surface-hover text-foreground'
                              : 'opacity-0 group-hover:opacity-100 text-foreground/50 hover:bg-surface-hover hover:text-foreground'
                          }`}
                          title="任务选项"
                          aria-label={`任务选项 ${task.title}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                            <circle cx="6" cy="2" r="1.1" />
                            <circle cx="6" cy="6" r="1.1" />
                            <circle cx="6" cy="10" r="1.1" />
                          </svg>
                        </button>

                        {menuOpen && (
                          <div
                            role="menu"
                            className="absolute right-1 top-full mt-1 w-40 py-1.5 rounded-lg border border-border bg-popover shadow-2xl text-sm z-50"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => viewTaskFiles(task)}
                              className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                            >
                              <svg width="13" height="13" viewBox="0 0 15 15" fill="none" className="text-foreground/60 flex-shrink-0">
                                <path d="M2 3.5a1 1 0 011-1h3l1.2 1.5H12a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-7.5z" stroke="currentColor" strokeWidth="1.2" />
                              </svg>
                              查看文件
                            </button>
                            {viewMode === 'grouped' && (
                              <>
                                <div className="my-1 border-t border-border" />
                                {currentGroupId ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      moveTaskToGroup(task.id, null)
                                      setTaskMenuId(null)
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                                  >
                                    移出分组
                                  </button>
                                ) : groups.length > 0 ? (
                                  <div className="px-3 pt-1 pb-0.5 text-xs text-foreground/40">移入分组</div>
                                ) : (
                                  <div className="px-3 py-1.5 text-xs text-foreground/40">暂无分组，点节头「＋」新建</div>
                                )}
                                {!currentGroupId && groups.map(g => (
                                  <button
                                    key={g.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      moveTaskToGroup(task.id, g.id)
                                      setTaskMenuId(null)
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors truncate"
                                  >
                                    {g.name}
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {/* Trailing drop indicator: when the pointer is past the last row. */}
            {dragId !== null && overIndex >= filteredOrdered.length && (
              <div className="h-0.5 -mx-1 rounded-full bg-brand/70" />
            )}
          </div>
        )}

        {/* 归档任务 */}
        {archivedTasks.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full px-3 py-1.5 text-xs font-semibold text-foreground/50 uppercase tracking-wider flex items-center justify-between"
            >
              <span>归档任务 ({archivedTasks.length})</span>
              <span className="text-foreground/30">{showArchived ? '▾' : '▸'}</span>
            </button>
            {showArchived && (
              <div className="space-y-1 mt-1">
                {sortedArchived.map(task => (
                  <button
                    key={task.id}
                    onClick={() => onTaskSelect(task.id)}
                    className="w-full text-left px-3 py-2 rounded-lg text-foreground/50 hover:bg-surface-hover hover:text-foreground/70 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-2 h-2 rounded-full bg-foreground/20 flex-shrink-0" />
                      <span className="text-sm truncate flex-1">{task.title}</span>
                    </div>
                    <div className="text-xs text-foreground/30 mt-0.5 pl-4.5">
                      {formatTime(task.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 账户区 — mirrors ZCode sidebar footer: avatar+name chip(has_menu) | remote | settings
          (ZC-ALIGN-002 C1-C3). Replaces the removed bottom StatusBar. */}
      <div className="bg-header border-t border-border px-3 py-2 flex items-center gap-1 select-none">
        <div ref={accountMenuRef} className="relative flex-1 min-w-0">
          <button
            onClick={() => { setAccountMenuOpen((v) => !v); setAccountSubmenu(null) }}
            className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-surface-hover transition-colors text-left"
            title="账号"
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
          >
            <span className="w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center text-xs font-semibold text-brand flex-shrink-0">
              {ACCOUNT_NAME.slice(0, 1).toUpperCase()}
            </span>
            <span className="text-sm font-medium text-foreground truncate">{ACCOUNT_NAME}</span>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-foreground/40 flex-shrink-0">
              <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>

          {/* 账户菜单（ZCode C1 实测：界面语言/界面主题/界面缩放 三子菜单 +
              使用统计/升级 + 断开连接）。每项都有真实跳转或如实说明。 */}
          {accountMenuOpen && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-2 w-56 py-1.5 rounded-lg border border-border bg-popover shadow-2xl text-sm z-50"
            >
              <SubmenuRow
                label="界面语言"
                open={accountSubmenu === 'locale'}
                onToggle={() => setAccountSubmenu(accountSubmenu === 'locale' ? null : 'locale')}
              >
                <MenuItem label="简体中文 ✓" onClick={() => { setAccountMenuOpen(false); setAccountSubmenu(null) }} />
                <MenuItem
                  label="其他语言…"
                  onClick={() => {
                    setAccountMenuOpen(false)
                    setAccountSubmenu(null)
                    toast('其他语言尚未提供：当前仅内置简体中文，语言包通道登记为后续项')
                  }}
                />
              </SubmenuRow>
              <SubmenuRow
                label="界面主题"
                open={accountSubmenu === 'theme'}
                onToggle={() => setAccountSubmenu(accountSubmenu === 'theme' ? null : 'theme')}
              >
                {THEME_OPTIONS.map((o) => (
                  <MenuItem
                    key={o.id}
                    label={themeMode === o.id ? `${o.label} ✓` : o.label}
                    onClick={() => applyTheme(o.id)}
                  />
                ))}
              </SubmenuRow>
              <SubmenuRow
                label="界面缩放"
                open={accountSubmenu === 'zoom'}
                onToggle={() => setAccountSubmenu(accountSubmenu === 'zoom' ? null : 'zoom')}
              >
                {ZOOM_OPTIONS.map((o) => (
                  <MenuItem key={o.factor} label={o.label} onClick={() => applyZoom(o.factor)} />
                ))}
              </SubmenuRow>
              <div className="my-1.5 border-t border-border" />
              <MenuItem
                label="使用统计"
                onClick={() => { setAccountMenuOpen(false); window.location.hash = '#/settings/usage' }}
              />
              <MenuItem
                label="升级"
                onClick={() => {
                  setAccountMenuOpen(false)
                  toast('升级通道未开通：当前构建为本地开发版，请使用 khy gateway 配置自己的模型通道')
                }}
              />
              <div className="my-1.5 border-t border-border" />
              <MenuItem
                label="断开连接"
                onClick={() => {
                  setAccountMenuOpen(false)
                  toast('当前为本地模式（未登录），无需断开连接')
                }}
              />
            </div>
          )}
        </div>
        <button
          onClick={() => toast('移动端远程控制未实现：需 relay 设备配对与扫码（登记于 ZC-ALIGN-002 M3）')}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
          title="移动端远程控制"
          aria-label="移动端远程控制"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="4" y="1.5" width="6" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 10.8h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          onClick={() => { window.location.hash = '#/settings' }}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
          title="设置"
          aria-label="设置"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 1.8v1.6M7 10.6v1.6M1.8 7h1.6M10.6 7h1.6M3.3 3.3l1.1 1.1M9.6 9.6l1.1 1.1M10.7 3.3L9.6 4.4M4.4 9.6l-1.1 1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      </>
      )}

      {/* 新建/重命名分组对话框:Electron 渲染层没有 window.prompt,用自绘浮层 */}
      {groupDialog && (
        <div
          className="absolute inset-0 z-50 bg-black/30 flex items-center justify-center"
          onMouseDown={() => setGroupDialog(null)}
        >
          <div
            className="bg-popover border border-border rounded-lg shadow-2xl p-3 w-60"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-foreground mb-2">
              {groupDialog.mode === 'create' ? '新建分组' : '重命名分组'}
            </div>
            <input
              autoFocus
              value={groupDialog.value}
              maxLength={60}
              onChange={(e) => setGroupDialog({ ...groupDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmGroupDialog()
                if (e.key === 'Escape') setGroupDialog(null)
              }}
              placeholder="分组名称"
              className="w-full bg-input border border-input-border rounded-md px-2 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused mb-3"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setGroupDialog(null)}
                className="px-3 py-1.5 rounded-md text-sm text-foreground/70 hover:bg-surface-hover transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmGroupDialog}
                className="px-3 py-1.5 rounded-md text-sm bg-brand text-white hover:opacity-90 transition-opacity"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 账户菜单条目（ZCode C1 菜单形态：一级项 + 可展开子菜单） ──
function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
    >
      {label}
    </button>
  )
}

function SubmenuRow({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
      >
        <span>{label}</span>
        <span className="text-foreground/40">{open ? '▾' : '›'}</span>
      </button>
      {open && <div className="pl-2 border-l border-border ml-3">{children}</div>}
    </div>
  )
}
