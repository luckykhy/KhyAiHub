// khy-canary: Khy-20261102-283-DYW8FWYR
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'

// 工作区文件树（侧栏 fileTree 视图，workspaceFileTree.* 文案）：
// 数据经 __KHYOS__.workspaceReadTree → main workspace:readTree（单目录懒加载，
// 展开时按需拉子层）。点文件 → 调用方在侧边面板打开 codeViewer 标签。

export interface TreeItem {
  name: string
  path: string
  kind: 'directory' | 'file'
}

interface ReadTreePayload {
  ok: boolean
  root?: string
  items?: TreeItem[]
  error?: string
}

interface FileTreeProps {
  // 选中文件 → 侧边面板 codeViewer 标签（AppLayout.openFileTab）
  onOpenFile: (filePath: string) => void
  // 可选树根：调用方有会话级工作区（session workspacePath）时传入该目录；
  // 缺省则回退主进程 cwd 工作区（旧行为）
  rootPath?: string
}

// Loading text carries action + target (Rule 2). Item count is unknown until
// readdir returns, so no fabricated progress digits are shown.
const loadingText = (dirName: string) => `读取 ${dirName} 目录…`

// 步长取 ZCode 真源（每级 .75rem + 基 .5rem，见
// zcode-analysis/unpacked/out/renderer/assets/styles-t2tKjMWX.css 的
// pl-[calc(var(--workspace-file-tree-depth)*.75rem+.5rem)]）—— 1:1 复刻以真源为准。
const INDENT_PX = 12

const loadDir = (dirPath: string, query: string): Promise<ReadTreePayload> => {
  const api = (window as unknown as {
    __KHYOS__?: { workspaceReadTree?: (dir?: string, q?: string) => Promise<ReadTreePayload> }
  }).__KHYOS__
  if (!api?.workspaceReadTree) {
    return Promise.resolve({
      ok: false,
      error: '文件树通道不可用：preload 未注入 __KHYOS__，请重启应用',
    })
  }
  return api.workspaceReadTree(dirPath, query)
}

export function FileTree({ onOpenFile, rootPath }: FileTreeProps) {
  const [resolvedRoot, setResolvedRoot] = useState('')
  const [rootName, setRootName] = useState('Workspace')
  const [items, setItems] = useState<TreeItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadSeq, setReloadSeq] = useState(0)
  const [search, setSearch] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Resolve the root once: caller-provided session workspace (rootPath prop)
  // takes priority; otherwise fall back to app:workspacePath (main process cwd)
  useEffect(() => {
    if (rootPath) {
      setResolvedRoot(rootPath)
      setRootName(rootPath.split(/[\\/]/).filter(Boolean).pop() || rootPath)
      return
    }
    const api = (window as unknown as {
      __KHYOS__?: { getWorkspacePath?: () => Promise<string> }
    }).__KHYOS__
    if (api?.getWorkspacePath) {
      api.getWorkspacePath().then((p) => {
        if (typeof p === 'string' && p) {
          setResolvedRoot(p)
          setRootName(p.split(/[\\/]/).filter(Boolean).pop() || 'Workspace')
        }
      })
    } else {
      setLoading(false)
      setError('工作区路径不可用：preload 未注入 __KHYOS__，请重启应用')
    }
  }, [rootPath])

  // Load the root level (and its filtered view) whenever root or search changes
  useEffect(() => {
    if (!resolvedRoot) return
    let cancelled = false
    setLoading(true)
    loadDir(resolvedRoot, search).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res?.ok) {
        setError(res?.error || '读取目录失败：主进程无响应，请重启应用')
        setItems([])
        return
      }
      setError('')
      setItems(res.items || [])
    })
    return () => { cancelled = true }
  }, [resolvedRoot, search, reloadSeq])

  // Escape clears the file search (workspaceFileTree.clearSearch)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && search) setSearch('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [search])

  const handleRefresh = useCallback(() => setReloadSeq((n) => n + 1), [])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部：workspaceFileTree.title + 返回任务由 WorkspaceSidebar 视图切换承担 */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 shrink-0">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0 text-foreground-muted">
          <path d="M2 4h8M2 4a1 1 0 011-1h2l1 1h3a1 1 0 011 1v4a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1" />
        </svg>
        <span className="text-sm font-medium text-foreground truncate" title={rootPath}>{rootName}</span>
        <div className="flex-1" />
        <button
          onClick={handleRefresh}
          className="w-7 h-7 rounded-md flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
          title="刷新文件树"
          aria-label="刷新文件树"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <path d="M12 7a5 5 0 11-1.5-3.5M12 1.5V4h-2.5" stroke="currentColor" strokeWidth="0.93" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 搜索框：workspaceFileTree.searchPlaceholder */}
      <div className="px-3 pb-2 shrink-0">
        <div className="relative">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索文件…"
            aria-label="搜索文件"
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:border-input-border-focused focus:outline-none transition-colors"
          />
          {search && (
            <button
              onClick={() => { setSearch(''); searchInputRef.current?.focus() }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
              title="清空文件搜索"
              aria-label="清空文件搜索"
            >
              <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="0.93" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 树体 */}
      <div className="flex-1 overflow-auto py-1">
        {loading ? (
          <div className="px-3 py-6 text-sm text-foreground-muted">{loadingText(rootName)}</div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <span className="mb-3 text-foreground-muted"><Icon name="warning" size={32} /></span>
            <span className="text-sm text-destructive leading-relaxed">{error}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="px-3 py-6 text-sm text-foreground-muted">
            {search ? '没有匹配的文件。' : '当前目录为空。'}
          </div>
        ) : (
          items.map((item) => (
            <TreeRow key={item.path} item={item} depth={0} onOpenFile={onOpenFile} />
          ))
        )}
      </div>
    </div>
  )
}

function TreeRow({
  item,
  depth,
  onOpenFile,
}: {
  item: TreeItem
  depth: number
  onOpenFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<TreeItem[]>([])
  const [childState, setChildState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const isDir = item.kind === 'directory'

  const toggle = useCallback(() => {
    if (!isDir) { onOpenFile(item.path); return }
    setExpanded((open) => {
      // First expansion lazily loads children (workspace:readTree per level)
      if (!open && childState === 'idle') {
        setChildState('loading')
        loadDir(item.path, '').then((res) => {
          if (!res?.ok) {
            setChildState('error')
            setChildren([])
            return
          }
          setChildren(res.items || [])
          setChildState('loaded')
        })
      }
      return !open
    })
  }, [isDir, item.path, childState, onOpenFile])

  return (
    <div>
      <button
        onClick={toggle}
        className="relative w-full flex items-center gap-1 px-2 py-1 mx-1 rounded-md text-left transition-colors hover:bg-surface-hover"
        style={{ paddingLeft: depth * INDENT_PX + 8 }}
        title={item.path}
      >
        <IndentGuides count={depth} boxLeft={4} />
        {isDir ? (
          <span className={`w-4 h-4 flex items-center justify-center text-foreground-subtle transition-transform duration-150 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}>
            <Icon name="chevron-right" size={12} />
          </span>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}
        <span className="w-4 text-center text-xs flex-shrink-0" aria-hidden="true">
          {isDir ? null : <Icon name={fileIcon(item.name)} size={13} />}
        </span>
        <span className="truncate text-sm text-foreground/90">{item.name}</span>
      </button>
      {expanded && isDir && (
        <div>
          {childState === 'loading' ? (
            <div className="relative px-3 py-1.5 text-xs text-foreground-muted" style={{ paddingLeft: (depth + 1) * INDENT_PX + 16 }}>
              <IndentGuides count={depth + 1} boxLeft={0} />
              {loadingText(item.name)}
            </div>
          ) : childState === 'error' ? (
            <div className="relative px-3 py-1.5 text-xs text-destructive" style={{ paddingLeft: (depth + 1) * INDENT_PX + 16 }}>
              <IndentGuides count={depth + 1} boxLeft={0} />
              读取目录失败：请检查目录权限后重试
            </div>
          ) : children.length === 0 ? (
            <div className="relative px-3 py-1.5 text-xs text-foreground-muted" style={{ paddingLeft: (depth + 1) * INDENT_PX + 16 }}>
              <IndentGuides count={depth + 1} boxLeft={0} />
              当前目录为空。
            </div>
          ) : (
            children.map((child) => (
              <TreeRow key={child.path} item={child} depth={depth + 1} onOpenFile={onOpenFile} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// 祖先列引导线：x 恒为「第 i 层父项箭头槽中线」= 12i + 20（树坐标）；
// boxLeft 传所在定位盒的左缘（行按钮 4 = mx-1，占位块 0），把树坐标换算到本盒坐标。
// 绝对定位元素绘制在行内内容之上，安全性来自「线不进内容列」（最内侧仍差 4px），
// 不来自 DOM 顺序或 z-index —— 若把线右移，它会静默盖在字形上。
function IndentGuides({ count, boxLeft }: { count: number; boxLeft: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-border pointer-events-none"
          style={{ left: i * INDENT_PX + 20 - boxLeft }}
        />
      ))}
    </>
  )
}

// 按扩展名映射图标（统一走 Icon 注册表，描边与全局一致）
const FILE_ICONS: Record<string, IconName> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  vue: 'code', json: 'file', md: 'doc', css: 'file', html: 'file',
  py: 'file', bat: 'terminal', ps1: 'terminal', sh: 'terminal', yml: 'terminal', yaml: 'terminal', toml: 'terminal',
}

function fileIcon(name: string): IconName {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICONS[ext] ?? 'file'
}
