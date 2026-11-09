// khy-canary: Khy-20261102-289-ESA2GVH8
import { useState, useEffect, useRef, Suspense, lazy } from 'react'
import { useAppDispatch } from '../../state/store'
import { addToast } from '../../state/toastSlice'
import { WorkspacePicker } from '../workspace/WorkspacePicker'
import { openWorkspace } from '../../utils/openWorkspace'
import { keyLabelFor } from '../../shared/keymap'
import { Icon, type IconName } from '../ui/Icon'
import { BrandMark } from '../ui/BrandMark'

const TITLEBAR_HEIGHT = 48
const CAPTION_BUTTON_WIDTH = 46

// 剥洋葱 · 视觉侧第六刀：进程监视器对话框按需加载。
//
// 守卫的候选扫描把它判为「可切」，依据：
//   ① 条件渲染（{processOpen && <ProcessMonitorDialog/>}）—— 窗口菜单点开才显示；
//   ② 传递重量 2 文件 / 453 行；
//   ③ **副作用有完整 cleanup**（1s 轮询 clearInterval + Esc 监听 removeEventListener）
//      —— 条件挂载不会漏订阅。
//
// ③ 还有一个反向收益：此前对话框**常驻挂载**，关着时那个 1s 轮询还在跑
// （每 1000ms 问一次 host 的进程信息）。改成条件挂载后，关着就不跑 ——
// 这正是「第三判据」的另一面：**常驻的副作用本身也是重量**。
const ProcessMonitorDialog = lazy(() =>
  import('./ProcessMonitorDialog').then((m) => ({ default: m.ProcessMonitorDialog }))
)

// 任务监控与进程监视器同样按需加载：点开才挂载，关着就不跑那 1s 轮询。
const TaskMonitorDialog = lazy(() =>
  import('./TaskMonitorDialog').then((m) => ({ default: m.TaskMonitorDialog }))
)

interface TitleBarProps {
  onToggleSidebar?: () => void
  sidebarVisible?: boolean
  onToggleSidePane?: () => void
  sidePaneVisible?: boolean
  onToggleTerminal?: () => void
  // 会话 tab 头：会话标题（空 → 「新任务」）
  sessionTitle?: string
  // 新建任务（窗口菜单 Ctrl+N）→ AppLayout 清会话 + 回启动卡片页
  onNewTask?: () => void
  // 重载会话 → 重新拉取当前会话消息
  onReloadSession?: () => void
  // 后退 / 前进（会话导航历史，AppLayout 持有栈）
  onBack?: () => void
  onForward?: () => void
  canBack?: boolean
  canForward?: boolean
}

type MenuItem =
  | { kind: 'action'; label: string; icon?: IconName; shortcut?: string; disabled?: boolean; run: () => void }
  | { kind: 'separator' }

export function TitleBar({
  onToggleSidebar,
  sidebarVisible = true,
  onToggleSidePane,
  sidePaneVisible = false,
  onToggleTerminal,
  sessionTitle,
  onNewTask,
  onReloadSession,
  onBack,
  onForward,
  canBack = false,
  canForward = false,
}: TitleBarProps) {
  const [platform, setPlatform] = useState('win32')
  const [menuOpen, setMenuOpen] = useState(false)
  const [processOpen, setProcessOpen] = useState(false)
  const [taskMonitorOpen, setTaskMonitorOpen] = useState(false)
  // Real workspace root from the main process. main resolves it through
  // getWorkspaceRoot() (settings.desktopWorkspacePath → cwd fallback), so the
  // chip follows 打开工作区 immediately instead of freezing the boot directory.
  const [workspacePath, setWorkspacePath] = useState('')
  const dispatch = useAppDispatch()

  const refreshWorkspacePath = () => {
    void apiRef.current?.getWorkspacePath?.().then((p: unknown) => {
      if (typeof p === 'string' && p) setWorkspacePath(p)
    }).catch(() => {})
  }

  useEffect(() => {
    const api = (window as any).__KHYOS__
    if (api) {
      setPlatform(api.getPlatform())
      void api.getWorkspacePath?.().then((p: unknown) => {
        if (typeof p === 'string' && p) setWorkspacePath(p)
      })
    }
  }, [])

  const isMac = platform === 'darwin'
  const api = (window as any).__KHYOS__ as
    | {
        openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>
        openPath?: (dir: string) => Promise<{ ok: boolean; error?: string }>
        openInEditor?: (target?: string) => Promise<{ ok: boolean; editor?: string; error?: string }>
        openDirectoryPicker?: () => Promise<string | null>
        setSetting?: (k: string, v: unknown) => Promise<void>
        getBrandingLinks?: () => Promise<{ ok: boolean; feedback?: string; docs?: string; community?: string; issues?: string; error?: string }>
        webVersion?: () => Promise<{ ok: boolean; url?: string; source?: 'settings' | 'default'; error?: string }>
        downloadArtifact?: (platform: 'android' | 'windows') =>
          Promise<{ ok: boolean; state?: 'local' | 'release' | 'missing'; fileName?: string; url?: string; error?: string }>
        closeWindow?: () => void
        openKeyManagerWindow?: () => Promise<void>
        getWorkspacePath?: () => Promise<string>
      }
    | undefined
  // api object is recreated每渲染，但 refreshWorkspacePath 在事件回调里用；
  // 用 ref 保证拿到最新一份而不触发 effect 重订阅。
  const apiRef = useRef(api)
  apiRef.current = api

  const toast = (title: string, type: 'info' | 'error' = 'info') => dispatch(addToast({ type, title }))
  const openUrl = async (url?: string) => {
    if (!url) {
      toast('链接不可用：品牌真源未配置，请检查 KHY_OS_DIR 与 serviceDefaults', 'error')
      return
    }
    const res = await api?.openExternal?.(url)
    if (res && !res.ok) toast(res.error || '外部链接打开失败', 'error')
  }

  // 四端互跳：桌面 → 网页版 / APK / 桌面安装包。地址与产物位置全在 main 侧解析
  // （设置 + serviceDefaults + downloadsCatalog），渲染层只负责把结果如实说出来。
  const openWebVersion = async () => {
    const w = await api?.webVersion?.()
    if (!w?.ok || !w.url) {
      toast(w?.error || '网页版地址不可用', 'error')
      return
    }
    const res = await api?.openExternal?.(w.url)
    if (res && !res.ok) { toast(res.error || '网页版打开失败', 'error'); return }
    toast(`已打开网页版：${w.url}${w.source === 'default' ? '（本机网页版端口，可在设置里改）' : ''}`)
  }
  const download = async (platform: 'android' | 'windows') => {
    const label = platform === 'android' ? 'Android 安装包' : 'Windows 安装包'
    const r = await api?.downloadArtifact?.(platform)
    if (!r?.ok) { toast(r?.error || `${label}下载入口不可用`, 'error'); return }
    if (r.state === 'local') toast(`已在资源管理器中定位 ${r.fileName || label}`)
    else toast(`本机没有${label}，已打开发布页：${r.url || ''}`)
  }

  // 打开工作区（窗口菜单 Ctrl+O）：收敛为 utils/openWorkspace.ts 的唯一入口
  // （[DESIGN-ARCH-125] P-02）。此前这里、WorkspaceSidebar、CommandCenter 各写了
  // 一遍 picker → setSetting → 广播；现在校验与持久化都在 main（workspace:open），
  // 渲染层只负责发起 + 广播 khy:workspace-changed + 提示用户。
  const pickWorkspace = async () => {
    await openWorkspace()
  }

  // 工作区根变更后重取（本组件用它给「在资源管理器中打开」等菜单项做可用性判断，
  // 不跟着刷新就会出现「已经切走了、菜单还在按旧根判断」）。
  useEffect(() => {
    window.addEventListener('khy:workspace-changed', refreshWorkspacePath)
    return () => window.removeEventListener('khy:workspace-changed', refreshWorkspacePath)
  }, [])

  const menuItems: MenuItem[] = [
    // 密钥与端点管理（[DESIGN-ARCH-091] §5.1 入口①）。该项原先只写在 src/main/menu.ts
    // 的原生「工具」菜单里，而那份菜单从未被引入、又被 Menu.setApplicationMenu(null)
    // 摘掉 —— 独立管理窗口因此只剩 `--key-manager` 启动一条路（入口③），入口① 名存实亡。
    // menu.ts 退役后入口迁到这里：自绘窗口菜单才是当前形态下唯一活着的菜单面。
    { kind: 'action', label: '密钥与端点管理', icon: 'settings', shortcut: keyLabelFor('openKeyManager'), run: () => { void api?.openKeyManagerWindow?.() } },
    { kind: 'separator' },
    // 键位标签取自 shared/keymap.ts 单一真源（[DESIGN-ARCH-125] P-03）：菜单里
    // 写死 'Ctrl+N' 而加速键没人实现，是命令面板与窗口菜单双双骗人的根源。
    { kind: 'action', label: '新建任务', icon: 'new-task', shortcut: keyLabelFor('newTask'), run: () => onNewTask?.() },
    { kind: 'action', label: '打开工作区', icon: 'folder', shortcut: keyLabelFor('openWorkspace'), run: () => { void pickWorkspace() } },
    { kind: 'action', label: '重新加载会话', icon: 'reload', run: () => onReloadSession?.() },
    { kind: 'action', label: '在资源管理器中打开', icon: 'open-file', run: () => {
      if (!workspacePath) { toast('工作区路径不可用：请重启应用后重试', 'error'); return }
      void api?.openPath?.(workspacePath).then((r) => { if (r && !r.ok) toast(r.error || '打开失败', 'error') })
    } },
    { kind: 'action', label: '在编辑器中打开', icon: 'code', run: () => {
      void api?.openInEditor?.(workspacePath).then((r) => {
        if (r && !r.ok) toast(r.error || '编辑器启动失败', 'error')
        else toast(`已在编辑器 ${r?.editor ?? ''} 中打开 ${workspacePath}`)
      })
    } },
    { kind: 'separator' },
    // 四端互跳：网页版地址与安装包位置由 main 解析（设置 / serviceDefaults /
    // downloadsCatalog 单一真源），这里只做入口，不在渲染层拼地址。
    { kind: 'action', label: '打开网页版', icon: 'browser', run: () => { void openWebVersion() } },
    { kind: 'action', label: '下载 Android 版', icon: 'download', run: () => { void download('android') } },
    { kind: 'action', label: '下载桌面版', icon: 'download', run: () => { void download('windows') } },
    { kind: 'separator' },
    { kind: 'action', label: '关于 KhyOS', icon: 'info', run: () => toast('KhyOS Desktop（开发构建）') },
    { kind: 'action', label: '检查更新', icon: 'arrow-up', run: () => toast('当前为开发构建：自动更新通道未配置，跳过检查') },
    { kind: 'action', label: '进程监视器', icon: 'report', run: () => setProcessOpen(true) },
    { kind: 'action', label: '任务监控', icon: 'report', run: () => setTaskMonitorOpen(true) },
    { kind: 'separator' },
    { kind: 'action', label: '问题反馈', icon: 'chat', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.feedback)) } },
    { kind: 'action', label: '给产品提需求', icon: 'chat-new', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.issues)) } },
    { kind: 'action', label: '用户社群', icon: 'plugins', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.community)) } },
    { kind: 'action', label: '产品文档', icon: 'doc', run: () => { void api?.getBrandingLinks?.().then((l) => openUrl(l.docs)) } },
    { kind: 'action', label: '导出日志', icon: 'file', run: () => toast('导出日志：请在应用数据目录 ~/.khyquant/logs 中查看（自动导出通道未接线）') },
    { kind: 'separator' },
    { kind: 'action', label: '关闭窗口', icon: 'close', run: () => api?.closeWindow?.() },
  ]

  return (
    <div
      className="bg-header flex items-center select-none"
      style={{ height: TITLEBAR_HEIGHT, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left icon group — mirrors ZCode D1: 切换侧边栏 / 后退 / 前进 */}
      {!isMac && (
        <div className="flex items-center gap-0.5 px-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={onToggleSidebar}
            className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/70 hover:text-foreground transition-colors"
            title="切换侧边栏"
            aria-label="切换侧边栏"
          >
            <Icon name="panel-left" size={14} />
          </button>
          <button
            onClick={onBack}
            disabled={!canBack}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
              canBack ? 'hover:bg-surface-hover text-foreground/70 hover:text-foreground' : 'text-foreground/25 cursor-default'
            }`}
            title={canBack ? '后退（上一个会话）' : '后退：没有更早的会话'}
            aria-label="后退"
          >
            <Icon name="chevron-left" size={14} />
          </button>
          <button
            onClick={onForward}
            disabled={!canForward}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
              canForward ? 'hover:bg-surface-hover text-foreground/70 hover:text-foreground' : 'text-foreground/25 cursor-default'
            }`}
            title={canForward ? '前进（下一个会话）' : '前进：没有更新的会话'}
            aria-label="前进"
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      )}
      <div
        className="flex-1 flex items-center gap-2 text-sm select-none min-w-0"
        style={{ paddingLeft: isMac ? 76 : 8 }}
      >
        {/* 品牌标：墨黑底 + 琥珀主标。此前标题栏没有任何品牌标识，
            整个桌面端看上去像「没有自己风格」的通用 Electron 壳。 */}
        <span
          className="flex items-center justify-center rounded-md bg-[#14110E] ring-1 ring-white/10 flex-shrink-0"
          style={{ width: 22, height: 22 }}
          aria-hidden="true"
        >
          <BrandMark size={14} />
        </span>
        {/* Session title + workspace chip — mirrors ZCode appHeader row
            (ZC-ALIGN-002 D5). Title reflects the selected session (host truth). */}
        <span className="text-foreground font-medium truncate max-w-[280px]" title={sessionTitle || '新任务'}>
          {sessionTitle || '新任务'}
        </span>
        {/* 工作空间 chip → 选择器（[DESIGN-ARCH-125] P-01）：点开即「最近打开 +
            打开其他文件夹…」，不再每次都弹系统目录框。与空态卡片顶端那行是同一个
            组件，两处永远显示同一个值（都以 workspace:list 真值为准）。 */}
        <WorkspacePicker variant="titlebar" />
      </div>
      {/* Right icon group — mirrors ZCode D2-D4: 展开侧边面板 / 切换终端 / 窗口菜单 */}
      {!isMac && (
        <div className="flex items-center gap-0.5 pr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={onToggleSidePane}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${
              sidePaneVisible
                ? 'bg-selected text-foreground'
                : 'hover:bg-surface-hover text-foreground/70 hover:text-foreground'
            }`}
            title={sidePaneVisible ? '收起侧边面板' : '展开侧边面板'}
            aria-label={sidePaneVisible ? '收起侧边面板' : '展开侧边面板'}
            aria-pressed={sidePaneVisible}
          >
            <Icon name="side-pane" size={14} />
          </button>
          <button
            onClick={onToggleTerminal}
            className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/70 hover:text-foreground transition-colors"
            title="切换终端"
            aria-label="切换终端"
          >
            <Icon name="terminal" size={14} />
          </button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className={`w-9 h-9 rounded-md flex items-center justify-center transition-colors ${menuOpen ? 'bg-selected text-foreground' : 'hover:bg-surface-hover text-foreground/70 hover:text-foreground'}`}
            title="窗口菜单"
            aria-label="窗口菜单"
          >
            <Icon name="menu" size={14} />
          </button>
        </div>
      )}
      {/* 窗口菜单自绘下拉 — ZCode L 区实测 12 项合并式（无边框窗口无原生菜单栏） */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} onClick={() => setMenuOpen(false)} />
          <div
            className="fixed right-2 top-12 z-50 w-64 py-1.5 rounded-lg border border-border bg-popover shadow-2xl text-sm select-none animate-scale-in origin-top-right"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {menuItems.map((item, idx) =>
              item.kind === 'separator' ? (
                <div key={`sep_${idx}`} className="my-1.5 border-t border-border" />
              ) : (
                <button
                  key={item.label}
                  disabled={item.disabled}
                  onClick={() => {
                    setMenuOpen(false)
                    item.run()
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    item.disabled
                      ? 'text-foreground/30 cursor-default'
                      : 'text-foreground hover:bg-surface-hover'
                  }`}
                >
                  {item.icon && <Icon name={item.icon} size={14} className="text-foreground-muted flex-shrink-0" />}
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut && <span className="text-xs text-foreground-muted">{item.shortcut}</span>}
                </button>
              )
            )}
          </div>
        </>
      )}
      {/* 进程监视器（窗口菜单 L4 / ZCode M1）：展示 main/host/scheduler 真实
          pid 与存活态（四进程架构自检的 UI 入口） */}
      {processOpen && (
        <Suspense fallback={null}>
          <ProcessMonitorDialog onClose={() => setProcessOpen(false)} />
        </Suspense>
      )}
      {/* 任务监控（窗口菜单）：本进程在跑的会话/工具 + 文件真源队列，只读 */}
      {taskMonitorOpen && (
        <Suspense fallback={null}>
          <TaskMonitorDialog onClose={() => setTaskMonitorOpen(false)} />
        </Suspense>
      )}
      {!isMac && (
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* 窗口标题栏按钮（系统语义控件）：三者形态各自不同 —— 最小化横线、
              最大化方框、关闭叉号 —— 但统一走全局图标注册表，描边与其余图标
              同为 1.6，不再各写各的 strokeWidth（此前这三枚是 1.5）。 */}
          <button onClick={() => (window as any).__KHYOS__?.minimizeWindow()} className="flex items-center justify-center hover:bg-surface-hover text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="最小化窗口">
            <Icon name="minimize" size={12} />
          </button>
          <button onClick={() => (window as any).__KHYOS__?.maximizeWindow()} className="flex items-center justify-center hover:bg-surface-hover text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="最大化或还原窗口">
            <Icon name="maximize" size={12} />
          </button>
          <button onClick={() => (window as any).__KHYOS__?.closeWindow()} className="flex items-center justify-center hover:bg-destructive text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="关闭">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
