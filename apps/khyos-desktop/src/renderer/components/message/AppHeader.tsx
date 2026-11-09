// khy-canary: Khy-20261102-293-13PMERCA
import { useEffect, useRef, useState } from 'react'
import { useAppDispatch } from '../../state/store'
import { addToast } from '../../state/toastSlice'

interface AppHeaderProps {
  sessionId?: string
  // 会话落盘 JSONL 的真实路径（后端 jsonlPathFor 解析结果）
  sessionJsonlPath?: string
  workspacePath?: string
  modelName?: string
  onReload?: () => void
}

export function AppHeader({ sessionId = '', sessionJsonlPath = '', workspacePath = '', modelName, onReload }: AppHeaderProps) {
  // Display-only: App.tsx passes the catalog-resolved label of the selected
  // model (P3-7④) or the '选择模型' placeholder; never a brand literal.
  const modelLabel = modelName ?? ''
  const [copied, setCopied] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  // 低频操作收进溢出菜单：此前 6 个等权文字按钮全时可见 + flex-wrap，窄窗口下
  // 折成两行把消息区再压掉一行；其中「复制工作区路径」与 TitleBar 的
  // WorkspacePicker chip 信息重复，唯一路径展示点留在 TitleBar。
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const dispatch = useAppDispatch()

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menuOpen])

  const copyToClipboard = async (text: string, label: string) => {
    if (!text) {
      dispatch(addToast({ type: 'error', title: '复制失败：内容为空，请先选择工作区或会话' }))
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      dispatch(addToast({ type: 'error', title: `复制失败：${String(err)}，请检查剪贴板权限` }))
    }
  }

  // 「重载会话」：真实重新拉取当前会话消息（App 层 session:messages 桥），
  // 无当前会话时 App 层会给出可选择会话的提示。
  const handleReload = () => {
    setReloading(true)
    onReload?.()
    setTimeout(() => setReloading(false), 1000)
  }

  const toast = (title: string, type: 'info' | 'error' = 'info') => dispatch(addToast({ type, title }))

  // 在编辑器中打开 / 在资源管理器中打开：都走 main 的真实 IPC
  const openInEditor = () => {
    const api = (window as unknown as {
      __KHYOS__?: { openInEditor?: (t?: string) => Promise<{ ok: boolean; state?: string; editor?: string; error?: string }> }
    }).__KHYOS__
    if (!api?.openInEditor) { toast('编辑器打开不可用：preload 未注入 __KHYOS__，请重启应用', 'error'); return }
    void api.openInEditor(workspacePath).then((r) => {
      if (!r?.ok) {
        toast(r.error || '编辑器启动失败', 'error')
        // 未配置外部编辑器不再是死路：落到内置文件选择器（AppLayout 监听后
        // 打开「打开文件」标签），用户直接从工作区选文件进内置编辑器。
        if (r.state === 'unconfigured') {
          window.dispatchEvent(new Event('khy:open-file-picker'))
        }
      }
      else toast(`已在编辑器 ${r.editor ?? ''} 中打开 ${workspacePath}`)
    }).catch((err: unknown) => toast(`编辑器启动失败：${String(err)}`, 'error'))
  }

  const openInFileManager = () => {
    const api = (window as unknown as {
      __KHYOS__?: { openPath?: (p: string) => Promise<{ ok: boolean; error?: string }> }
    }).__KHYOS__
    if (!workspacePath) { toast('工作区路径不可用：请先在窗口菜单中打开工作区', 'error'); return }
    if (!api?.openPath) { toast('打开目录不可用：preload 未注入 __KHYOS__，请重启应用', 'error'); return }
    void api.openPath(workspacePath).then((r) => {
      if (r && !r.ok) toast(r.error || '打开失败', 'error')
    }).catch((err: unknown) => toast(`打开目录失败：${String(err)}`, 'error'))
  }

  const runFromMenu = (fn: () => void) => {
    setMenuOpen(false)
    fn()
  }

  return (
    <div className="bg-panel border-b border-border px-4 py-2 flex items-center gap-2">
      {/* 会话信息：模型 + 会话 ID（工作区路径只在 TitleBar 出现一次） */}
      <div className="flex items-center gap-2 text-xs text-foreground-muted mr-2 min-w-0">
        {modelLabel && (
          <>
            <span className="font-medium text-foreground/80">{modelLabel}</span>
            <span className="text-foreground-subtle">·</span>
          </>
        )}
        {sessionId && (
          <span className="truncate max-w-[220px]" title={sessionId}>会话 {sessionId.slice(0, 8)}</span>
        )}
      </div>

      <div className="flex-1" />

      {/* 操作组：常态只留高频动作（重载），其余收进「更多操作」溢出菜单 */}
      <div ref={menuRef} className="flex items-center gap-1" >
        <button
          onClick={handleReload}
          disabled={reloading}
          className="px-2.5 py-1.5 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5 disabled:opacity-50"
          title="重载会话"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={reloading ? 'animate-spin' : ''}>
            <path d="M2.5 6a3.5 3.5 0 016.7-1.3M9.5 6a3.5 3.5 0 01-6.7 1.3" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
            <path d="M9 2.5V4H7.5M3 9.5V8H4.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{reloading ? '重载中…' : '重载'}</span>
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className={`px-2 py-1.5 rounded-md text-xs transition-colors flex items-center gap-1.5 ${
              menuOpen ? 'bg-selected text-foreground' : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
            }`}
            title="更多会话操作"
            aria-label="更多会话操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <circle cx="2.5" cy="6" r="1.1" />
              <circle cx="6" cy="6" r="1.1" />
              <circle cx="9.5" cy="6" r="1.1" />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-60 py-1.5 rounded-lg border border-border bg-popover shadow-2xl text-sm z-50"
            >
              <button
                role="menuitem"
                onClick={() => runFromMenu(() => { void copyToClipboard(workspacePath, 'path') })}
                className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors truncate"
                title={workspacePath || '尚未选择工作区'}
              >
                {copied === 'path' ? '已复制工作区路径' : '复制工作区路径'}
              </button>
              <button
                role="menuitem"
                onClick={() => runFromMenu(() => { void copyToClipboard(sessionId, 'session') })}
                className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
              >
                {copied === 'session' ? '已复制会话 ID' : '复制会话 ID'}
              </button>
              <button
                role="menuitem"
                onClick={() => runFromMenu(() => { void copyToClipboard(sessionJsonlPath, 'jsonl') })}
                className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                title={sessionJsonlPath || '请先选择一个会话'}
              >
                {copied === 'jsonl' ? '已复制 JSONL 路径' : '复制 JSONL 路径'}
              </button>
              <div className="my-1.5 border-t border-border" />
              <button
                role="menuitem"
                onClick={() => runFromMenu(openInEditor)}
                className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
                title="编辑器取 设置 → 常规 或 KHY_EDITOR"
              >
                在编辑器中打开
              </button>
              <button
                role="menuitem"
                onClick={() => runFromMenu(openInFileManager)}
                className="w-full text-left px-3 py-1.5 text-foreground hover:bg-surface-hover transition-colors"
              >
                在资源管理器中打开
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
