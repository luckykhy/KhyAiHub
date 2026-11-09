// khy-canary: Khy-20261102-290-Y9S14WM0
import { useState, useMemo, useEffect, useRef, useCallback, Suspense, lazy } from 'react'
import { useAppDispatch } from '../../state/store'
import { addToast } from '../../state/toastSlice'
import { Icon } from '../ui/Icon'
import {
  baseName,
  classifyWorkspacePath,
  inferredColorKey,
  parentPath,
  type ProjectColorKey,
  type ProjectIconName,
  type ProjectRegistration,
} from '../../shared/sidebarProjectClassify'
import { describeSessionListEmpty, describeSessionListError } from './sessionListLoad'
import { useChatIdentity, ACCOUNT_NAME_SETTING, DEFAULT_ACCOUNT_NAME, broadcastIdentity } from '../../shared/chatIdentity'
import { useAccountAvatar } from '../../shared/accountAvatar'

// 设置里读回的登记项做形状校验：设置文件是用户可手改的 JSON，形状不对时
// 丢弃该条而不是把 undefined 灌进判定层（那是崩溃而非降级）。
function isProjectRegistration(v: unknown): v is ProjectRegistration {
  return !!v && typeof v === 'object' && typeof (v as ProjectRegistration).path === 'string'
}

// 登记对话框的图标候选（Icon 注册表的前 8 枚）与颜色候选。
// 颜色**不含**任何映射到 --color-brand 的键：品牌色是全局强调色（工程蓝），
// 项目身份色若也占用品牌色，选中的项目就会与「当前项」混成一类。
const PROJECT_ICON_CHOICES: ProjectIconName[] = [
  'new-task', 'search', 'automation', 'plugins',
  'report', 'bug', 'review', 'doc',
]
const PROJECT_COLOR_CHOICES: { key: ProjectColorKey; className: string }[] = [
  { key: 'green', className: 'bg-success' },
  { key: 'blue', className: 'bg-[var(--color-input-border-focused)]' },
  { key: 'amber', className: 'bg-warning' },
  { key: 'red', className: 'bg-destructive' },
  { key: 'purple', className: 'bg-[var(--color-popover-header)]' },
  { key: 'teal', className: 'bg-[var(--color-foreground)]' },
]
const projectColorClass = (key: ProjectColorKey | undefined) =>
  PROJECT_COLOR_CHOICES.find(c => c.key === key)?.className

// 图标/颜色候选的 tooltip 文案：直接把内部键名（new-task / green）摆给用户看
// 等于暴露实现细节，这里给一层中文名映射。
const PROJECT_ICON_LABELS: Record<ProjectIconName, string> = {
  'new-task': '新建任务', search: '搜索', automation: '自动化', plugins: '插件',
  'remote-mobile': '移动端', settings: '设置', report: '报告', bug: '报错',
  ppt: '演示文稿', review: '代码审查', doc: '文档', idle: '闲时任务',
}
const PROJECT_COLOR_LABELS: Record<ProjectColorKey, string> = {
  green: '绿色', blue: '蓝色', amber: '琥珀色',
  red: '红色', purple: '紫色', teal: '青色',
}

// 账号显示名不在这里写死：真源是 settings.desktopAccountName，
// 经 shared/chatIdentity 读取（设置 → 常规 → 账号 可改）。

// 界面主题 / 界面缩放档位（账户菜单子菜单，对齐 ZCode C1 实测：
// 系统默认/深色主题/浅色主题 + 缩放三档，当前选中项由勾选图标标出）。
// 值取自 theme.ts 的 mode 枚举与 main zoom:set 的 0.5–2.0 夹紧区间。
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

// 剥洋葱 · 视觉侧第一刀：文件树按需加载。
//
// 侧栏有两个视图（tasks / fileTree），文件树只在点「查看文件」后才渲染 ——
// 是典型的「点开才看」面板。此前用静态 import，于是它进了首屏闭包：
// 守卫的 visual-layer-direction 判据（V0 不得依赖 V1）报的就是这条边。
//
// 与 App.tsx 的三个全屏页（Settings / Automations / KeyManager）同型处理：
// React.lazy + Suspense，命名导出用 .then(m => ({ default: m.X })) 转 default 形态。
const FileTree = lazy(() => import('../filetree/FileTree').then((m) => ({ default: m.FileTree })))

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
  // 会话列表正在加载（含自动重试中）—— 用于骨架态与「重试」按钮的禁用态。
  sessionLoading?: boolean
  // 手动重试入口（错误态的「重试」按钮）。AppLayout 负责真正的重新拉取。
  onReloadTasks?: () => void
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
  sessionLoading = false,
  onReloadTasks,
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
  // 改名入口：点「改名」就地展开输入框，不跳设置页（这是快捷方式，不是跳转）。
  const [accountRenameOpen, setAccountRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [themeMode, setThemeMode] = useState('system')
  const accountMenuRef = useRef<HTMLDivElement>(null)
  // 任务行三点菜单：当前展开的行 id（ZCode 真源 B7 的行级操作，复刻为 ⋮ 子菜单）
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null)
  // 文件树根目录：null = 主进程 cwd 工作区（顶部导航「查看文件」行为）；
  // 会话级目录 = 会话三点菜单「查看文件」触发时该 session 的 workspacePath
  const [fileTreeRoot, setFileTreeRoot] = useState<string | null>(null)
  const dispatch = useAppDispatch()
  const { userName: accountName } = useChatIdentity()
  const accountAvatar = useAccountAvatar()

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

  // 失败态文案走纯函数（可测），渲染层不自己拼句子。
  const sessionErrorText = useMemo(
    () => describeSessionListError(sessionError)
      || { title: '会话列表读取失败', detail: sessionError, hint: '可点「重试」重新读取；若持续失败请重启应用。' },
    [sessionError],
  )

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
            void moveTaskToGroup(cur.id, null)
            toast('已移出分组，回到自动分组')
          } else if (targetFolder.startsWith('group:')) {
            const gid = targetFolder.slice('group:'.length)
            const g = groups.find(x => x.id === gid)
            if (g?.kind === 'system') {
              // 系统组由自动规则维护，手动塞进去会让规则与事实打架。
              toast(`「${g.name}」是自动分组，不能手动归入`, 'error')
            } else {
              void moveTaskToGroup(cur.id, gid)
              toast(g ? `已移入分组「${g.name}」` : '已移入分组')
            }
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

  // ── 视图分组:项目 tab 按 workspacePath 自动分文件夹;分组 tab 走后端分组 ────
  // 分组真源在后端 SQLite（sessionGroupService，[DESIGN-ARCH-183]）：
  //   · 系统组按「来源 + 时间衰减」自动归类（定时任务/闲时任务/手动会话/今天/本周/更早）
  //   · 用户组是用户自己建的，存后端 → 清缓存不丢、桌面端/TUI/网页端共享一份
  // 旧实现把分组与归属关系放在 renderer localStorage（当时宿主桥没有 group API），
  // 后果是「所有会话堆在未分组」且换设备即丢。现在改为读后端真源。
  const GROUPS_KEY = 'khy.sidebar.groups'
  const TASK_GROUP_KEY = 'khy.sidebar.taskGroup'
  const MIGRATED_KEY = 'khy.sidebar.groups.migratedAt'
  type SidebarGroup = {
    id: string
    name: string
    sortOrder: number
    color: string
    kind: 'system' | 'user'
    rule: string | null
  }
  const [groups, setGroups] = useState<SidebarGroup[]>([])
  // sessionId → groupId（后端算好的归属，渲染层不自己判规则）
  const [groupAssignment, setGroupAssignment] = useState<Record<string, string>>({})
  const [groupsError, setGroupsError] = useState('')

  // 宿主桥的分组 API（preload 注入）。取不到就退化成「无分组」并说明原因，
  // 绝不假装有分组（假数据比没有更误导）。
  const groupApi = () => (window as unknown as {
    __KHYOS__?: {
      listSessionGroups?: (limit?: number) => Promise<{
        ok: boolean
        result?: {
          groups?: Array<{ id: string; title: string; color?: string; kind?: string; rule?: string | null; sortOrder?: number }>
          assignment?: Record<string, string>
        }
        error?: string
      }>
      createSessionGroup?: (title: string, color?: string) => Promise<{ ok: boolean; result?: { group?: unknown }; error?: string }>
      updateSessionGroup?: (groupId: string, patch: { title?: string; color?: string }) => Promise<{ ok: boolean; result?: { group?: unknown }; error?: string }>
      deleteSessionGroup?: (groupId: string) => Promise<{ ok: boolean; error?: string }>
      moveSessionToGroup?: (sessionId: string, groupId: string | null, projectKey?: string) => Promise<{ ok: boolean; error?: string }>
      importSessionGroups?: (groups: unknown[], assignments: Record<string, string>) => Promise<{ ok: boolean; error?: string }>
    }
  }).__KHYOS__

  // 拉分组树（分组视图的数据源）。后端一次算好「组 + 每个会话的归属」。
  const loadGroups = useCallback(async () => {
    const api = groupApi()
    if (!api?.listSessionGroups) {
      setGroupsError('分组功能不可用：宿主桥未注入分组接口，请重启应用')
      return
    }
    try {
      const res = await api.listSessionGroups(50)
      if (!res.ok) {
        setGroupsError(res.error || '读取会话分组失败：请查看导出日志排查 host 状态')
        return
      }
      const raw = res.result?.groups || []
      setGroups(raw.map((g, index) => ({
        id: g.id,
        name: g.title,
        sortOrder: typeof g.sortOrder === 'number' ? g.sortOrder : index,
        color: g.color || 'gray',
        kind: g.kind === 'system' ? 'system' : 'user',
        rule: g.rule ?? null,
      })))
      setGroupAssignment(res.result?.assignment || {})
      setGroupsError('')
    } catch (err) {
      setGroupsError(`读取会话分组失败：${err instanceof Error ? err.message : String(err)}，请重试`)
    }
  }, [])

  // 分组视图每次进入都刷新一次（会话来源/归属可能已变），失败时保留上一次结果。
  useEffect(() => {
    if (viewMode !== 'grouped') return
    void loadGroups()
  }, [viewMode, loadGroups])

  // 一次性迁移：旧 renderer localStorage 分组 → 后端 SQLite（[DESIGN-ARCH-183] §8）。
  // 迁移成功后只留一个标记，不再读旧键（保留原始数据作为只读备份）。
  useEffect(() => {
    const api = groupApi()
    if (!api?.importSessionGroups) return
    let rawGroups: unknown
    let rawMap: unknown
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return
      rawGroups = JSON.parse(localStorage.getItem(GROUPS_KEY) || 'null')
      rawMap = JSON.parse(localStorage.getItem(TASK_GROUP_KEY) || 'null')
    } catch {
      return
    }
    if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
      try { localStorage.setItem(MIGRATED_KEY, String(Date.now())) } catch { /* 私有模式 */ }
      return
    }
    const assignments = (rawMap && typeof rawMap === 'object' ? rawMap : {}) as Record<string, string>
    void api.importSessionGroups(rawGroups, assignments).then((res) => {
      if (res?.ok) {
        try { localStorage.setItem(MIGRATED_KEY, String(Date.now())) } catch { /* 私有模式 */ }
        void loadGroups()
      }
    }).catch(() => { /* 迁移失败就保持现状，用户仍可手动建组 */ })
  }, [loadGroups])

  // 只有用户自建的分组可以被手动归入；系统组由自动规则维护。
  const userGroups = useMemo(() => groups.filter((g) => g.kind === 'user'), [groups])

  // 折叠的文件夹 key 集合(内存态,默认全展开)
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set())
  const toggleFolder = (key: string) =>
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // 新建/重命名分组的小对话框（Electron 渲染层没有 window.prompt）。
  // mode: create | rename；color: 分组颜色（新建时可改）。
  const [groupDialog, setGroupDialog] = useState<{
    mode: 'create' | 'rename'
    groupId?: string
    value: string
    color: string
  } | null>(null)

  // 分组颜色候选（与后端 sessionGroupService.GROUP_COLORS 对齐）
  const GROUP_COLOR_CHOICES: { key: string; className: string; label: string }[] = [
    { key: 'gray', className: 'bg-foreground/30', label: '灰色' },
    { key: 'green', className: 'bg-success', label: '绿色' },
    { key: 'blue', className: 'bg-[var(--color-input-border-focused)]', label: '蓝色' },
    { key: 'yellow', className: 'bg-warning', label: '黄色' },
    { key: 'orange', className: 'bg-[var(--color-popover-header)]', label: '橙色' },
    { key: 'red', className: 'bg-destructive', label: '红色' },
    { key: 'purple', className: 'bg-[var(--color-brand)]', label: '紫色' },
  ]

  // 分组颜色 → 样式类（与后端 sessionGroupService.GROUP_COLORS 同一套键）。
  const groupColorClass = (key: string | undefined) =>
    GROUP_COLOR_CHOICES.find(c => c.key === key)?.className || 'bg-foreground/30'

  const toast = (title: string, type: 'info' | 'error' = 'info') => dispatch(addToast({ type, title }))

  // 新建 / 重命名分组 —— 落库在后端，渲染层不自己造第二份真源。
  const confirmGroupDialog = async () => {
    if (!groupDialog) return
    const name = groupDialog.value.trim()
    const api = groupApi()
    if (!name) {
      toast('请先给分组起个名字', 'error')
      return
    }
    if (!api) {
      toast('分组功能不可用：宿主桥未注入分组接口，请重启应用', 'error')
      return
    }
    setGroupDialog(null)
    if (groupDialog.mode === 'create') {
      const res = await api.createSessionGroup?.(name, groupDialog.color)
      if (!res?.ok) {
        toast(res?.error || '创建分组失败：请重试', 'error')
        return
      }
      toast(`已创建分组「${name}」· 把会话拖到分组上即可归类`)
    } else if (groupDialog.groupId) {
      const res = await api.updateSessionGroup?.(groupDialog.groupId, { title: name })
      if (!res?.ok) {
        toast(res?.error || '重命名分组失败：请重试', 'error')
        return
      }
      toast('已重命名分组')
    }
    await loadGroups()
  }

  const deleteGroup = async (g: SidebarGroup) => {
    const api = groupApi()
    if (!api?.deleteSessionGroup) {
      toast('分组功能不可用：宿主桥未注入分组接口，请重启应用', 'error')
      return
    }
    const res = await api.deleteSessionGroup(g.id)
    if (!res?.ok) {
      toast(res?.error || '删除分组失败：请重试', 'error')
      return
    }
    toast(`已删除分组「${g.name}」，组内会话回到自动分组`)
    await loadGroups()
  }

  // 归组：写后端（唯一真源），本地状态随后端刷新。
  const moveTaskToGroup = async (taskId: string, groupId: string | null) => {
    const api = groupApi()
    if (!api?.moveSessionToGroup) {
      toast('分组功能不可用：宿主桥未注入分组接口，请重启应用', 'error')
      return
    }
    const res = await api.moveSessionToGroup(taskId, groupId)
    if (!res?.ok) {
      toast(res?.error || '归组失败：请重试', 'error')
      return
    }
    await loadGroups()
  }

  // 项目身份登记（[DESIGN-ARCH-177] §3.1）。持久化到 main 的 settingsStore
  // （desktopProjects），与分组一样经 preload 的 settings:get/set 走既有通道 ——
  // **不新增 IPC**（新通道即第二个真源）。
  //
  // 顺序纪律（重要）：本段整体位于 `toast` 声明**之后**。React 的依赖数组 / JSX /
  // 组件体表达式都是渲染期求值，若 useCallback 包的回调在依赖数组里引用了
  // 后面才声明的 const，每次渲染都会抛 `Cannot access 'x' before
  // initialization`，React 卸载整棵树 = 纯白屏（见 [DESIGN-ARCH] skill §8.5
  // 中 AutomationsPage 的同病实例）。新增 hook 块时请保持声明在前、引用在后。
  const [projectRegs, setProjectRegs] = useState<ProjectRegistration[]>([])
  // 系统临时目录根（main 侧 os.tmpdir()）。渲染层不自己拼路径 —— 平台差异只
  // 应该有一处知道。拿不到就空数组，退化为只按 TRANSIENT_PREFIXES 判。
  const [tempRoots, setTempRoots] = useState<string[]>([])
  const [projectDialog, setProjectDialog] = useState<{
    path: string
    // 编辑既有登记时的原 path：用户改了文件夹后要能把旧键删掉，否则同一条
    // 登记会在两个路径下各留一份。
    originalPath?: string
    value: string
    icon?: ProjectIconName
    color?: ProjectColorKey
  } | null>(null)

  // 首次挂载拉一次登记。渲染层不缓存第二份真源：读回后仍以 settings 为准，
  // 写操作直接落 settings 再更新本组件状态（单一真源 = main 侧 settings.json）。
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: {
        getSettings?: () => Promise<Record<string, unknown>>
        workspaceList?: () => Promise<{ ok?: boolean; tempRoots?: unknown }>
      }
    }).__KHYOS__
    void api?.getSettings?.().then((s) => {
      const raw = s?.desktopProjects
      if (Array.isArray(raw)) setProjectRegs(raw.filter(isProjectRegistration))
    }).catch(() => {
      // 读不到就保持空登记 —— 判定层对 undefined 兼容，全部走 inferred，行为同旧版。
    })
    void api?.workspaceList?.().then((r) => {
      const roots = r?.tempRoots
      if (Array.isArray(roots)) {
        setTempRoots(roots.filter((x): x is string => typeof x === 'string' && !!x))
      }
    }).catch(() => {
      // 拿不到临时目录根不影响主功能：锚定前缀那一路仍然生效。
    })
  }, [])

  const saveProjectRegs = useCallback((next: ProjectRegistration[]) => {
    setProjectRegs(next)
    const api = (window as unknown as { __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<boolean> } }).__KHYOS__
    void api?.setSetting?.('desktopProjects', next).catch(() => toast('项目登记保存失败：设置未能落盘', 'error'))
  }, [toast])

  const confirmProjectDialog = useCallback(() => {
    if (!projectDialog) return
    const name = projectDialog.value.trim()
    const path = projectDialog.path.trim()
    if (name && path) {
      saveProjectRegs([
        ...projectRegs.filter(r => r.path !== path && r.path !== projectDialog.originalPath),
        { path, name, icon: projectDialog.icon, color: projectDialog.color },
      ])
      toast(`已登记项目「${name}」`)
    }
    setProjectDialog(null)
  }, [projectDialog, projectRegs, saveProjectRegs, toast])

  const openProjectDialog = useCallback((path: string) => {
    const hit = projectRegs.find(r => r.path === path)
    setProjectDialog({
      path,
      originalPath: hit?.path,
      value: hit?.name || baseName(path),
      icon: hit?.icon,
      color: hit?.color,
    })
  }, [projectRegs])

  interface SidebarFolder {
    key: string
    kind: 'project' | 'group' | 'unassigned' | 'ungrouped'
    name: string
    items: Task[]
    groupRef?: SidebarGroup
    // 项目文件夹的身份字段（group/unassigned 为 undefined）。
    projectPath?: string
    icon?: ProjectIconName
    color?: ProjectColorKey
    inferred?: boolean
  }

  // 两个 tab 的文件夹化视图:数据源同为 filteredOrdered(已含手动排序 + 搜索过滤),
  // 分桶维度不同 —— 项目 tab 派生自 workspacePath 经判定层,分组 tab 派生自自建分组。
  const folders = useMemo<SidebarFolder[]>(() => {
    if (viewMode === 'grouped') {
      // 归属由后端算好（显式归属 > 来源组 > 时间桶），渲染层只做展示分桶。
      const byGroup = new Map<string, Task[]>()
      const ungrouped: Task[] = []
      for (const t of filteredOrdered) {
        const gid = groupAssignment[t.id]
        if (gid && groups.some(g => g.id === gid)) {
          const arr = byGroup.get(gid) || []
          arr.push(t)
          byGroup.set(gid, arr)
        } else {
          ungrouped.push(t)
        }
      }
      // 空系统组不显示（它们是自动规则的产物，没有成员就没什么可说）；
      // 空用户组照常显示 —— 用户刚建的组要看得见，并且能拿到「怎么往里放」的指引。
      const visible = groups.filter((g) => (g.kind === 'system' ? (byGroup.get(g.id)?.length ?? 0) > 0 : true))
      const out: SidebarFolder[] = visible
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map(g => ({ key: `group:${g.id}`, kind: 'group' as const, name: g.name, items: byGroup.get(g.id) || [], groupRef: g }))
      if (ungrouped.length) out.push({ key: 'ungrouped', kind: 'ungrouped', name: '未分组', items: ungrouped })
      return out
    }
    // 项目视图:按「cwd 所属的项目根」分桶，而不是按 cwd 本身。
    // cwd 是会话当时的工作目录，可能是项目里的任意一层（runtime/node/backend），
    // 也可能是项目根的父目录（D:\Portable）。登记项 path 即项目根，其下任意层
    // 子目录的会话都归入同一个项目 —— 否则同一仓库会按子目录裂成多行。
    // 未登记的路径仍按自身精确分桶（177 的旧行为），可一键登记。
    const byRoot = new Map<string, { c: ReturnType<typeof classifyWorkspacePath>; items: Task[] }>()
    const unassigned: Task[] = []
    for (const t of filteredOrdered) {
      const p = t.workspacePath || ''
      const c = classifyWorkspacePath(p, projectRegs, { transientRoots: tempRoots })
      // 空 workspacePath 与仓外临时目录都属于「未归属」—— 它们没有项目身份。
      if (!p || c.bucket === 'transient') {
        unassigned.push(t)
        continue
      }
      const hit = byRoot.get(c.rootPath)
      if (hit) hit.items.push(t)
      else byRoot.set(c.rootPath, { c, items: [t] })
    }
    const out: SidebarFolder[] = []
    for (const [root, { c, items }] of byRoot) {
      out.push({
        key: `project:${root}`,
        kind: 'project',
        name: c.name,
        items,
        projectPath: root,
        icon: c.icon,
        color: c.color,
        inferred: c.inferred,
      })
    }
    // 未归属组永远排在最后 —— 它不是「项目」。
    if (unassigned.length) {
      out.push({ key: 'unassigned', kind: 'unassigned', name: '未归属', items: unassigned })
    }
    return out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'unassigned' ? 1 : -1
      // items 已按手动序/时间排好,首项即最近活跃
      return (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0)
    })
  }, [viewMode, filteredOrdered, groups, groupAssignment, projectRegs, tempRoots])

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

  // 菜单一收，未提交的改名词就作废：下次点「改名」应该从当前名字重新起笔，
  // 而不是把上一次取消掉的内容又摆出来。
  useEffect(() => {
    if (accountMenuOpen) return
    setAccountRenameOpen(false)
    setRenameDraft('')
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

  // 改名：落 settings.desktopAccountName（空 = 默认「本地用户」），再广播
  // khy:identity —— 消息头里已渲染的用户轮标签立刻换，不用重开会话。
  const commitAccountName = () => {
    const api = (window as unknown as { __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<boolean> } }).__KHYOS__
    const next = renameDraft.trim()
    setAccountRenameOpen(false)
    setRenameDraft('')
    setAccountMenuOpen(false)
    setAccountSubmenu(null)
    void api?.setSetting?.(ACCOUNT_NAME_SETTING, next).then(() => {
      broadcastIdentity({}, ACCOUNT_NAME_SETTING, next)
      toast(next ? `已改名为「${next}」` : `已恢复默认用户名「${DEFAULT_ACCOUNT_NAME}」`)
    }).catch(() => toast('改名失败：设置未能落盘，请重启应用后重试', 'error'))
  }

  // 换头像：文件对话框挑图（PNG/JPG/GIF/WebP/AVIF/BMP），存的是原文件路径，
  // 每次挂载按路径重读 —— 换图只改那一个文件即可。共享 hook 负责广播，
  // 设置页里的头像圈也会跟着换。
  const pickAccountAvatar = async () => {
    setAccountMenuOpen(false)
    setAccountSubmenu(null)
    const result = await accountAvatar.pick()
    if (result.canceled) return
    toast(result.ok ? '头像已更换' : result.error || '换头像失败：未知原因', result.ok ? 'info' : 'error')
  }

  const resetAccountAvatar = async () => {
    setAccountMenuOpen(false)
    setAccountSubmenu(null)
    const result = await accountAvatar.clear()
    toast(result.ok ? '已恢复默认头像' : result.error || '恢复默认头像失败：未知原因', result.ok ? 'info' : 'error')
  }

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
      className="bg-sidebar border-r border-border-strong flex flex-col h-full overflow-hidden relative"
      style={width ? { width: `${width}px` } : undefined}
    >
      {view === 'fileTree' ? (
        <>
          {/* 文件树视图头：返回任务（workspaceFileTree.backToTasks）+ Workspace
              标题由 FileTree 头部渲染；这里只留顶部切换条 */}
          <div className="px-3 pt-3 pb-2 flex items-center gap-2">
            <button
              onClick={() => setView('tasks')}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover transition-colors"
              title="返回任务"
              aria-label="返回任务"
            >
              <Icon name="chevron-left" size={14} className="flex-shrink-0" />
              <span>返回任务</span>
            </button>
          </div>
          {/* 树体占满剩余高度；文件点击 → 上层 codeViewer 标签。key 绑定工作区
              纪元 + 树根：换工作区或从会话三点菜单进文件树（根不同）时重挂载，
              按新根重新拉树 */}
          <div className="flex-1 overflow-hidden">
            <Suspense fallback={<div className="p-3" />}>
              <FileTree
                key={`${workspaceEpoch}:${fileTreeRoot || 'workspace'}`}
                onOpenFile={onOpenFile || (() => {})}
                rootPath={fileTreeRoot || undefined}
              />
            </Suspense>
          </div>
        </>
      ) : (
      <>
      {/* 顶部导航区 — mirrors ZCode B1-B4: 新建任务 Ctrl+N / 搜索 Ctrl+K /
          自动化 / 插件市场, full-width 40px rows (ZC-ALIGN-002 实测) */}
      <div className="px-3 pt-3 pb-1 flex flex-col gap-0.5">
        <button
          onClick={onNewTask}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <Icon name="new-task" size={15} className="flex-shrink-0" />
          <span className="flex-1">新建任务</span>
          <span className="text-xs text-foreground-muted">Ctrl+N</span>
        </button>
        <button
          onClick={() => window.dispatchEvent(new Event('khy:open-command-center'))}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <Icon name="search" size={15} className="flex-shrink-0" />
          <span className="flex-1">搜索</span>
          <span className="text-xs text-foreground-muted">Ctrl+K</span>
        </button>
        <button
          onClick={() => { window.location.hash = '#/automations' }}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <Icon name="automation" size={15} className="flex-shrink-0" />
          <span className="flex-1">自动化</span>
        </button>
        <button
          onClick={() => { window.location.hash = '#/settings/plugins' }}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <Icon name="plugins" size={15} className="flex-shrink-0" />
          <span className="flex-1">插件市场</span>
        </button>
        <button
          onClick={() => { window.location.hash = '#/environments' }}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm text-foreground hover:bg-surface-hover transition-colors text-left"
        >
          <Icon name="code" size={15} className="flex-shrink-0" />
          <span className="flex-1">开发环境</span>
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="px-3 pb-2 border-b border-border">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="搜索任务…"
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:border-input-border-focused focus:outline-none transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              title="清空搜索"
              aria-label="清空搜索"
            >
              <Icon name="close" size={10} />
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
              : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          项目
        </button>
        <button
          onClick={() => onViewModeChange('grouped')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'grouped'
              ? 'bg-selected text-foreground'
              : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          分组
        </button>
        <div className="flex-1" />
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as 'updatedAt' | 'createdAt')}
          title="排序方式"
          aria-label="排序方式"
          className="khy-select text-xs bg-input border border-input-border rounded-md px-2.5 py-1.5 text-foreground-muted focus:border-input-border-focused focus:outline-none transition-colors"
        >
          <option value="updatedAt">更新时间</option>
          <option value="createdAt">创建时间</option>
        </select>
      </div>

      {/* 任务列表 — 横向不留内边距：行的左缘由行内 px-3 决定，与上方各区块的
          px-3 对齐（此前容器 p-2 + 行 px-3 让左缘在 8/10/12px 之间来回跳） */}
      <div
        className={`flex-1 overflow-auto py-2 ${dragId !== null ? 'select-none' : ''}`}
        style={dragId !== null ? { cursor: 'grabbing' } : undefined}
      >
        {sessionError && tasks.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground-muted text-sm py-12 px-4 text-center">
            <span className="mb-3 text-foreground-muted"><Icon name="warning" size={32} /></span>
            <span className="font-medium text-foreground/70">{sessionErrorText.title}</span>
            <span className="text-xs text-foreground-muted mt-1.5 leading-relaxed">{sessionErrorText.detail}</span>
            <span className="text-xs text-foreground-muted mt-1 leading-relaxed max-w-[240px]">{sessionErrorText.hint}</span>
            {/* 重试入口：失败态必须给一条出路，不能只剩一句「读取失败」。 */}
            <button
              type="button"
              onClick={() => onReloadTasks?.()}
              disabled={sessionLoading}
              className="mt-4 px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {sessionLoading ? '正在重试…' : '重试'}
            </button>
          </div>
        ) : sessionLoading && tasks.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground-muted text-sm py-12">
            <span className="mb-3 text-foreground-muted"><Icon name="search" size={32} /></span>
            <span className="font-medium">正在读取会话列表…</span>
            <span className="text-xs text-foreground-muted mt-1">正在从本机会话库加载</span>
          </div>
        ) : filteredOrdered.length === 0 && !searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground-muted text-sm py-12">
            <span className="mb-3 text-foreground-muted"><Icon name="folder" size={32} /></span>
            <span className="font-medium">还没有任务</span>
            <span className="text-xs text-foreground-muted mt-1">{describeSessionListEmpty(false)}</span>
          </div>
        ) : filteredOrdered.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-foreground-muted text-sm py-12">
            <span className="mb-3 text-foreground-muted"><Icon name="search" size={32} /></span>
            <span className="font-medium">没有匹配的任务</span>
            <span className="text-xs text-foreground-muted mt-1">{describeSessionListEmpty(true)}</span>
          </div>
        ) : (
          <div className="space-y-1">
            {/* 视图节头:标题随 tab 变化(项目/分组);收起按钮必须留在可见区，
                否则收起后无法再展开（此前整块包在 !collapsed 里 = 折叠即死路） */}
            <div className="px-3 py-1.5 text-xs font-medium text-foreground flex items-center justify-between">
              <span>{viewMode === 'grouped' ? '分组' : '项目'}</span>
              <div className="flex items-center gap-0.5">
                {viewMode === 'grouped' && (
                  <button
                    onClick={() => setGroupDialog({ mode: 'create', value: '', color: 'blue' })}
                    className="w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
                    title="新建分组：用来手动归类会话（系统已按来源与最近活跃自动分组）"
                    aria-label="新建分组"
                  >
                    <Icon name="plus" size={13} />
                  </button>
                )}
                <button
                  onClick={() => setCollapsed(!collapsed)}
                  className="w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
                  title={collapsed ? '展开列表' : '收起列表'}
                  aria-label={collapsed ? '展开列表' : '收起列表'}
                  aria-expanded={!collapsed}
                >
                  <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                </button>
              </div>
            </div>
            {!collapsed && groupsError && viewMode === 'grouped' && (
              // 分组读不到时的显式失败态（不是静默退化成「没有分组」——
              // 那会让用户以为分组被清空了）。
              <div className="mx-3 mb-1 px-2.5 py-2 rounded-lg border border-border bg-surface-hover/40 text-[11px] text-foreground-muted leading-relaxed">
                {groupsError}
                <button
                  type="button"
                  onClick={() => void loadGroups()}
                  className="ml-1 underline underline-offset-2 hover:text-foreground"
                >
                  重试
                </button>
              </div>
            )}
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
                    className={`group/f relative flex items-center gap-1.5 px-3 py-1 mt-0.5 rounded-md text-xs font-medium text-foreground-muted cursor-pointer select-none hover:bg-surface-hover hover:text-foreground transition-colors ${
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
                    {/* 折叠箭头：走 Icon 注册表（描边 1.6，与相邻 lucide 图标同字重）。
                        箭头槽仍是 w-2，图标在槽内居中 —— 引导线的中线位置不变 */}
                    <span className="text-foreground-subtle w-2 flex-shrink-0 flex items-center justify-center" aria-hidden="true">
                      <Icon name={folderCollapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                    </span>
                    {/* 身份色条（[DESIGN-ARCH-177] §3.3）：已登记用登记色，未登记
                        用稳定散列色（inferredColorKey）。只由 3px 竖条承载 —— 不给
                        文字上色，那会与 60% 透明度档位抢语义层级，且浅色主题
                        下对比度不可控 */}
                    {folder.kind === 'project' && (
                      <span
                        className={`w-[3px] h-3.5 rounded-full flex-shrink-0 ${projectColorClass(folder.color) || projectColorClass(inferredColorKey(folder.projectPath || folder.key)) || 'bg-foreground/30'}`}
                        aria-hidden="true"
                      />
                    )}
                    {folder.kind === 'project' && folder.icon && (
                      <Icon name={folder.icon} size={13} className="text-foreground-muted flex-shrink-0" />
                    )}
                    {folder.kind === 'group' && folder.groupRef && (
                      // 分组身份标记：系统组用 # （自动规则，固定 ID），用户组用颜色点。
                      // 两者一眼可分 —— 用户需要知道哪些能改、哪些不能。
                      folder.groupRef.kind === 'system' ? (
                        <span className="text-foreground-muted text-[11px] flex-shrink-0" aria-hidden="true">#</span>
                      ) : (
                        <span
                          className={`w-[3px] h-3.5 rounded-full flex-shrink-0 ${groupColorClass(folder.groupRef.color)}`}
                          aria-hidden="true"
                        />
                      )
                    )}
                    <span className={`truncate flex-1 text-left ${folder.inferred ? 'text-foreground-muted' : ''}`}>
                      {folder.name}
                    </span>
                    <span className="text-foreground-muted flex-shrink-0">{folder.items.length}</span>
                    {/* 推测项目名 → 给「登记为项目」入口（P3 的最小闭环）。只在
                        项目 tab 出现，且已登记的项不再显示（改登记走同一个入口） */}
                    {folder.kind === 'project' && folder.projectPath && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); openProjectDialog(folder.projectPath!) }}
                        className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                          projectDialog?.path === folder.projectPath
                            ? 'opacity-100 bg-surface-hover text-foreground'
                            : 'opacity-0 group-hover/f:opacity-100 focus-visible:opacity-100 text-foreground-muted hover:text-foreground'
                        }`}
                        title={folder.inferred ? '登记为项目（起个正式名字）' : '编辑项目登记'}
                        aria-label={`项目设置 ${folder.name}`}
                        aria-haspopup="dialog"
                        aria-expanded={projectDialog?.path === folder.projectPath}
                      >
                        <Icon name="settings" size={12} />
                      </button>
                    )}
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
                            : 'opacity-0 group-hover/f:opacity-100 focus-visible:opacity-100 text-foreground-muted hover:text-foreground'
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
                  {/* 推测项目名的路径副行（[DESIGN-ARCH-177] §3.3）：让「父目录冒充
                      项目」这类问题自暴露。只在 inferred 态渲染 —— 已登记项的路径
                      已被用户认可为身份，再显示路径只是噪音 */}
                  {folder.kind === 'project' && folder.inferred && folder.projectPath && (
                    <div
                      className="px-3 pb-1 mt-[-2px] ml-[18px] text-[11px] text-foreground-muted truncate"
                      title={folder.projectPath}
                    >
                      {folder.projectPath}
                    </div>
                  )}
                  {folder.kind === 'group' && folder.groupRef && folderMenuOpen && (
                    <div
                      role="menu"
                      className="ml-6 mt-0.5 mb-1 w-36 py-1 rounded-lg border border-border bg-popover shadow-2xl text-sm z-50"
                    >
                      {folder.groupRef.kind === 'system' ? (
                        // 系统组由自动规则维护：改名/删除/改色都在服务层被拒，
                        // 这里说明原因而不是给一个点了会报错的按钮。
                        <div className="px-3 py-1.5 text-xs text-foreground-muted leading-relaxed">
                          自动分组，按规则归类，不能改名或删除
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setGroupDialog({ mode: 'rename', groupId: folder.groupRef!.id, value: folder.groupRef!.name, color: folder.groupRef!.color })
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
                              void deleteGroup(folder.groupRef!)
                              setTaskMenuId(null)
                            }}
                            className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                          >
                            删除分组
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* 子级缩进 + 引导线：引导线画在文件夹头折叠箭头的中线上
                    （16 = px-3(12) + w-2 箭头槽一半(4)）。子项阶梯按「父级标题列再往右一格 12px」定：
                    项目文件夹的名称在 54（12 + 8 + gap 6 + 色条 3 + gap 6 + 图标 13 + gap 6），
                    卡片块左缘取 34 = 16 + border-l(1) + pl-[17px] —— 卡片内 px-3(12) 之后状态点在 46、
                    标题列 66 = 54 + 12，父子标题正好差一格。更早的版本块左缘是 24、标题列 56，比父级
                    名称只右 4px，等于没有层级（这正是「标题和子项看着不像一棵树」的由来）；头部内边距
                    从 px-2.5 调到 px-3 时，引导线也要跟着从 14 挪到 16，否则会脱离箭头中线。
                    分组文件夹没有色条与图标（名称在 26），子项左缘同样统一到 34，两个 tab 的阶梯一致。
                    注意不是 ml-16：Tailwind 的 ml-16 = 4rem = 64px。 */}
                  {!folderCollapsed && (
                    <div className="ml-[16px] border-l border-border pl-[17px]">
                      {/* 空的用户自建分组要给出「怎么往里放」的指引 —— 只显示一个
                          光秃秃的组名，用户会以为功能坏了。系统组不会出现空态
                          （空系统组根本不渲染）。 */}
                      {folder.kind === 'group' && folder.items.length === 0 && (
                        <div className="px-3 py-2 text-[11px] text-foreground-muted leading-relaxed">
                          空分组 · 把会话拖到「{folder.name}」上，或在会话的 ⋮ 菜单里选「移入分组」
                        </div>
                      )}
                      {folder.items.map(task => {
                        const menuOpen = taskMenuId === task.id
                        const isDragging = dragId === task.id
                        const rowIdx = rowIndexById.get(task.id) ?? -1
                        const showDropBefore = dragId !== null && overIndex === rowIdx && !isDragging
                        // 当前会话归属的**用户**分组（系统组由自动规则维护，
                        // 不算「用户指定了归属」，所以这里只认用户组）。
                        const assignedGroupId = groupAssignment[task.id] || null
                        const currentGroupId = assignedGroupId && groups.some((g) => g.id === assignedGroupId && g.kind === 'user')
                          ? assignedGroupId
                          : null
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
                                {/* 状态点：当前只有「激活 / 非激活」两档可表达 ——
                                    会话对象里没有运行状态字段（AppLayout 的
                                    listSessions 映射也只有 id/title/cwd/时间），
                                    所以运行中/完成/失败这套语义暂时没有数据来源。
                                    此处先做激活态改造（品牌色 + 光晕），
                                    语义映射待数据层补上 running/done/error 后再接。 */}
                                <span
                                  aria-hidden="true"
                                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-colors ${
                                    activeTaskId === task.id
                                      ? 'bg-brand ring-2 ring-brand/25'
                                      : 'bg-foreground/20'
                                  }`}
                                />
                                <span className="text-sm font-medium truncate flex-1">{task.title}</span>
                              </div>
                              <div className="text-xs text-foreground-muted mt-1 pl-5">
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
                                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-foreground-muted hover:bg-surface-hover hover:text-foreground'
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
                                  <Icon name="folder" size={13} className="text-foreground-muted flex-shrink-0" />
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
                                          void moveTaskToGroup(task.id, null)
                                          setTaskMenuId(null)
                                        }}
                                        className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                                      >
                                        移出分组
                                      </button>
                                    ) : userGroups.length > 0 ? (
                                      <div className="px-3 pt-1 pb-0.5 text-xs text-foreground">移入分组</div>
                                    ) : (
                                      <div className="px-3 py-1.5 text-xs text-foreground-muted">还没有自建分组：点分组节头的 ＋ 新建</div>
                                    )}
                                    {!currentGroupId && userGroups.map(g => (
                                      <button
                                        key={g.id}
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                          void moveTaskToGroup(task.id, g.id)
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
                  )}
                </div>
              )
            })}
            {/* Trailing drop indicator: when the pointer is past the last row. */}
            {dragId !== null && overIndex >= filteredOrdered.length && (
              <div className="h-0.5 -mx-1 rounded-full bg-brand/70" />
            )}
          </div>
        )}

        {/* 归档任务 — 与上方文件夹头同一左缘（px-3），行几何与活动行一致
            （px-3 py-2.5 + 状态点槽位），弱化只靠颜色不靠尺寸：此前归档行用
            px-3 py-2、时间行 pl-4.5，左缘比树子项靠左约 33px，像从别的面板借来 */}
        {archivedTasks.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full px-3 py-1.5 text-xs font-medium text-foreground flex items-center justify-between"
            >
              <span>归档任务 ({archivedTasks.length})</span>
              <span className="text-foreground-subtle flex items-center justify-center" aria-hidden="true">
                <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={12} />
              </span>
            </button>
            {showArchived && (
              <div className="space-y-1 mt-1">
                {sortedArchived.map(task => (
                  <button
                    key={task.id}
                    onClick={() => onTaskSelect(task.id)}
                    className="w-full text-left px-3 py-2.5 rounded-lg text-foreground-muted hover:bg-surface-hover hover:text-foreground/70 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-foreground/20 flex-shrink-0" />
                      <span className="text-sm truncate flex-1">{task.title}</span>
                    </div>
                    <div className="text-xs text-foreground-muted mt-1 pl-5">
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
            {/* 默认头像是桌宠抠图立绘：原图四周留白多，放大 1.4 倍才在 28px 圈里看得清脸；
                外圈 overflow-hidden 兜住，免得画到名字上。自选头像按原图铺满，不缩放。 */}
            <span className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0">
              {accountAvatar.dataUrl ? (
                <img src={accountAvatar.dataUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <img src={accountAvatar.defaultUrl} alt="" className="w-full h-full object-cover scale-[1.4]" />
              )}
            </span>
            <span className="text-sm font-medium text-foreground truncate">{accountName}</span>
            <Icon name="chevron-down" size={10} className="text-foreground-subtle flex-shrink-0" />
          </button>

          {/* 账户菜单（ZCode C1 实测：界面语言/界面主题/界面缩放 三子菜单 +
              使用统计/升级 + 断开连接）。每项都有真实跳转或如实说明。 */}
          {accountMenuOpen && (
            <div
              role="menu"
              className="absolute bottom-full left-0 mb-2 w-56 py-1.5 rounded-lg border border-border bg-popover shadow-2xl text-sm z-50"
            >
              {/* 账号自己的两件事放最上面：改名就地编辑，换头像直接开文件选择。
                  都落 settings.json；名字的其它入口仍在 设置 → 常规 → 账号。 */}
              {accountRenameOpen ? (
                <div className="px-3 pt-1.5 pb-2">
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // 菜单的全局 Escape 会收掉整个菜单；这里先拦下，改成只退出编辑。
                      e.stopPropagation()
                      if (e.key === 'Enter') commitAccountName()
                      if (e.key === 'Escape') {
                        setAccountRenameOpen(false)
                        setRenameDraft('')
                      }
                    }}
                    placeholder={`留空恢复默认（${DEFAULT_ACCOUNT_NAME}）`}
                    aria-label="新用户名"
                    className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-foreground-muted focus:border-brand/60"
                  />
                  <div className="flex items-center justify-end gap-2 mt-2">
                    <button
                      onClick={() => {
                        setAccountRenameOpen(false)
                        setRenameDraft('')
                      }}
                      className="px-2.5 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={commitAccountName}
                      className="px-2.5 py-1 rounded-md text-xs font-medium text-brand bg-brand-subtle hover:opacity-85 transition-opacity"
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <MenuItem
                  label="改名"
                  onClick={() => {
                    // 当前还是默认名时留空：直接保存就等于「恢复默认」，不会把
                    // 「本地用户」当成用户起过的名字写进设置。
                    setRenameDraft(accountName === DEFAULT_ACCOUNT_NAME ? '' : accountName)
                    setAccountRenameOpen(true)
                    setAccountSubmenu(null)
                  }}
                />
              )}
              <MenuItem label="换头像" onClick={() => void pickAccountAvatar()} />
              {accountAvatar.path ? (
                <MenuItem label="恢复默认头像" onClick={() => void resetAccountAvatar()} />
              ) : null}
              <div className="my-1.5 border-t border-border" />
              <SubmenuRow
                label="界面语言"
                open={accountSubmenu === 'locale'}
                onToggle={() => setAccountSubmenu(accountSubmenu === 'locale' ? null : 'locale')}
              >
                <MenuItem label="简体中文" checked onClick={() => { setAccountMenuOpen(false); setAccountSubmenu(null) }} />
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
                    label={o.label}
                    checked={themeMode === o.id}
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
          onClick={() => { window.location.hash = '#/settings/remote' }}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
          title="移动端远程控制"
          aria-label="移动端远程控制"
        >
          <Icon name="remote-mobile" size={14} />
        </button>
        <button
          onClick={() => { window.location.hash = '#/settings' }}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
          title="设置"
          aria-label="设置"
        >
          <Icon name="settings" size={14} />
        </button>
      </div>
      </>
      )}

      {/* 登记项目对话框（[DESIGN-ARCH-177] §3.4）：照 groupDialog 的自绘浮层形态。
          图标/颜色**默认留空** —— 预选就是给假数据；留空则不渲染该标识。
          遮罩与面板形状对齐全屏对话框那一档（50% + blur、rounded-2xl），此前
          侧栏这两个弹层是 30% 无模糊 + rounded-lg，同是「一个对话框」却两套观感。 */}
      {projectDialog && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center"
          onMouseDown={() => setProjectDialog(null)}
        >
          <div
            className="bg-popover border border-popover-border rounded-2xl shadow-2xl p-4 w-72"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-foreground mb-1">登记项目</div>
            <div className="text-[11px] text-foreground-muted mb-2 leading-relaxed">
              项目 = 一个文件夹。该文件夹下任意子目录里的会话都归入这个项目。
            </div>
            <div className="text-xs text-foreground-muted mb-1">项目文件夹</div>
            <div className="flex items-center gap-1 mb-1">
              <input
                value={projectDialog.path}
                onChange={(e) => setProjectDialog({ ...projectDialog, path: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmProjectDialog()
                  if (e.key === 'Escape') setProjectDialog(null)
                }}
                placeholder="D:\path\to\project"
                className="flex-1 min-w-0 bg-input border border-input-border rounded-md px-2 py-1.5 text-xs text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-input-border-focused"
              />
              <button
                type="button"
                onClick={() => setProjectDialog({ ...projectDialog, path: parentPath(projectDialog.path) })}
                title="上一级文件夹"
                aria-label="上一级文件夹"
                className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                <Icon name="arrow-up" size={12} />
              </button>
            </div>
            <div className="text-[11px] text-foreground-muted mb-3 truncate">
              默认项目名：{baseName(projectDialog.path) || '—'}
            </div>
            <div className="text-xs text-foreground-muted mb-1">显示名</div>
            <input
              autoFocus
              value={projectDialog.value}
              maxLength={60}
              onChange={(e) => setProjectDialog({ ...projectDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmProjectDialog()
                if (e.key === 'Escape') setProjectDialog(null)
              }}
              placeholder="项目名称"
              className="w-full bg-input border border-input-border rounded-md px-2 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-input-border-focused mb-3"
            />
            <div className="text-xs text-foreground-muted mb-1.5">图标（可选）</div>
            <div className="flex flex-wrap gap-1 mb-3">
              {PROJECT_ICON_CHOICES.map(ic => (
                <button
                  key={ic}
                  type="button"
                  onClick={() => setProjectDialog({ ...projectDialog, icon: projectDialog.icon === ic ? undefined : ic })}
                  className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                    projectDialog.icon === ic
                      ? 'bg-selected text-foreground ring-1 ring-brand/30'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground'
                  }`}
                  title={`图标：${PROJECT_ICON_LABELS[ic]}`}
                  aria-label={`图标 ${PROJECT_ICON_LABELS[ic]}`}
                  aria-pressed={projectDialog.icon === ic}
                >
                  <Icon name={ic} size={13} />
                </button>
              ))}
            </div>
            <div className="text-xs text-foreground-muted mb-1.5">颜色（可选）</div>
            <div className="flex gap-1.5 mb-3">
              {PROJECT_COLOR_CHOICES.map(c => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setProjectDialog({ ...projectDialog, color: projectDialog.color === c.key ? undefined : c.key })}
                  className={`w-5 h-5 rounded-full ${c.className} transition-transform ${
                    projectDialog.color === c.key ? 'ring-2 ring-foreground/60 scale-110' : 'opacity-70 hover:opacity-100'
                  }`}
                  title={`颜色：${PROJECT_COLOR_LABELS[c.key]}`}
                  aria-label={`颜色 ${PROJECT_COLOR_LABELS[c.key]}`}
                  aria-pressed={projectDialog.color === c.key}
                />
              ))}
            </div>
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setProjectDialog(null)}
                className="px-3 py-1.5 rounded-md text-sm text-foreground/70 hover:bg-surface-hover transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmProjectDialog}
                className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active transition-colors"
              >
                登记
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建/重命名分组对话框:Electron 渲染层没有 window.prompt,用自绘浮层。
          「新建分组」原本只有一个光秃秃的输入框 —— 用户看不出分组是干什么的、
          建完要往里放什么、跟上面的自动分组是什么关系。现在把三件事讲清楚：
            1. 分组是什么（手动归类会话的容器）
            2. 系统已经按规则分好了（定时任务/闲时任务/手动会话/今天/本周/更早）
            3. 建完之后怎么用（拖会话进组，或在会话菜单里「移入分组」） */}
      {groupDialog && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center"
          onMouseDown={() => setGroupDialog(null)}
        >
          <div
            className="bg-popover border border-popover-border rounded-2xl shadow-2xl p-4 w-72"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-foreground mb-1">
              {groupDialog.mode === 'create' ? '新建分组' : '重命名分组'}
            </div>
            {groupDialog.mode === 'create' ? (
              <div className="text-xs text-foreground-muted leading-relaxed mb-3">
                分组用来把会话归到一起。系统已按「来源 + 最近活跃」自动分好
                （定时任务 / 闲时任务 / 手动会话 / 今天 / 本周 / 更早）；
                你建的分组用来<strong className="text-foreground/80">手动归类</strong>：
                建好后把会话<strong className="text-foreground/80">拖到分组名上</strong>，
                或在会话的 ⋮ 菜单里选「移入分组」。
              </div>
            ) : (
              <div className="text-xs text-foreground-muted leading-relaxed mb-3">
                给分组换个更清楚的名字。会话归属不会变。
              </div>
            )}
            <input
              autoFocus
              value={groupDialog.value}
              maxLength={60}
              onChange={(e) => setGroupDialog({ ...groupDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmGroupDialog()
                if (e.key === 'Escape') setGroupDialog(null)
              }}
              placeholder={groupDialog.mode === 'create' ? '分组名称，例如：技术调研' : '分组名称'}
              className="w-full bg-input border border-input-border rounded-md px-2 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-input-border-focused mb-3"
            />
            {groupDialog.mode === 'create' && (
              <>
                <div className="text-xs text-foreground-muted mb-1.5">颜色（可选）</div>
                <div className="flex gap-1.5 mb-3">
                  {GROUP_COLOR_CHOICES.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setGroupDialog({ ...groupDialog, color: c.key })}
                      className={`w-5 h-5 rounded-full ${c.className} transition-transform ${
                        groupDialog.color === c.key ? 'ring-2 ring-foreground/60 scale-110' : 'opacity-70 hover:opacity-100'
                      }`}
                      title={`颜色：${c.label}`}
                      aria-label={`颜色 ${c.label}`}
                      aria-pressed={groupDialog.color === c.key}
                    />
                  ))}
                </div>
              </>
            )}
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
                onClick={() => void confirmGroupDialog()}
                className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active transition-colors"
              >
                {groupDialog.mode === 'create' ? '创建分组' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 账户菜单条目（ZCode C1 菜单形态：一级项 + 可展开子菜单） ──
// checked：当前选中项在行尾渲染一枚品牌色勾选图标（此前是行内文字里的
// 勾选字符，字重与相邻图标对不齐，且与图标注册表的描边基线不一致）。
function MenuItem({
  label,
  onClick,
  checked,
}: {
  label: string
  onClick: () => void
  checked?: boolean
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-surface-hover transition-colors"
    >
      <span className="flex-1 truncate">{label}</span>
      {checked && <Icon name="check" size={12} className="text-brand flex-shrink-0" />}
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
        <span className="text-foreground-subtle flex items-center justify-center" aria-hidden="true">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </span>
      </button>
      {open && <div className="pl-2 border-l border-border ml-3">{children}</div>}
    </div>
  )
}
