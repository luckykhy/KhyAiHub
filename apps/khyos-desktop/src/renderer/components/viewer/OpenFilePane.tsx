// khy-canary: Khy-20261102-334-C4YKFDFW
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { Skeleton } from '../ui/Skeleton'

// 打开文件选择器（sidePane.openFile.* 文案）：
// 标题/说明/占位符/加载文案/空态文案均取自 i18n（sidePane.openFile、
// openFileDescription、openFilePlaceholder、openFileLoading、openFileEmpty）。
// 数据经 __KHYOS__.workspaceListFiles → main workspace:listFiles（有界遍历，
// 只索引文本类文件）。选中文件 → 调用方打开 codeViewer 标签。

interface WorkspaceFilesPayload {
  ok: boolean
  root?: string
  files?: { path: string; name: string }[]
  error?: string
}

interface OpenFilePaneProps {
  onOpenFile: (filePath: string) => void
}

// 加载态的骨架行（宽度错落，纯布局）
const SKELETON_ROW_WIDTHS = ['w-2/5', 'w-1/3', 'w-1/2', 'w-2/7', 'w-1/3']

export function OpenFilePane({ onOpenFile }: OpenFilePaneProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [error, setError] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Load the workspace index once; typing only filters client-side
  useEffect(() => {
    let cancelled = false
    const api = (window as unknown as {
      __KHYOS__?: { workspaceListFiles?: (q?: string) => Promise<WorkspaceFilesPayload> }
    }).__KHYOS__
    if (!api?.workspaceListFiles) {
      setError('文件索引通道不可用：preload 未注入 __KHYOS__，请重启应用')
      setLoading(false)
      return
    }
    api.workspaceListFiles('').then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res?.ok) {
        setError(res?.error || '文件索引不可用：主进程无响应，请重启应用')
        return
      }
      setFiles(res.files || [])
    }).catch(() => {
      if (!cancelled) {
        setLoading(false)
        setError('文件索引请求失败：主进程无响应，请重启应用')
      }
    })
    return () => { cancelled = true }
  }, [])

  const filtered = query.trim()
    ? files.filter(f => f.path.toLowerCase().includes(query.trim().toLowerCase()))
    : files

  useEffect(() => { setSelectedIndex(0) }, [query])

  useEffect(() => {
    const selected = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const file = filtered[selectedIndex]
      if (file) onOpenFile(file.path)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部：sidePane.openFileDescription */}
      <div className="px-4 pt-4 pb-2 shrink-0 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{t('sidePane.openFile')}</h3>
          <p className="text-xs text-foreground-muted mt-1">{t('sidePane.openFileDescription')}</p>
        </div>
        {!loading && !error && (
          <span className="shrink-0 mt-0.5 rounded-md bg-surface px-1.5 py-0.5 text-[11px] tabular-nums text-foreground-muted">
            {filtered.length}
          </span>
        )}
      </div>
      {/* 搜索框 */}
      <div className="px-3 pb-2 shrink-0">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('sidePane.openFilePlaceholder')}
          className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:border-input-border-focused focus:outline-none transition-colors"
        />
      </div>
      {/* 文件列表 */}
      <div ref={listRef} className="flex-1 overflow-auto px-2 pb-2">
        {loading ? (
          // 索引是整目录读回来的，等待期用骨架占位：先摆出列表版式，
          // 文件到位后原地替换，视线不跳（不再是一句居中灰字）。
          <div className="px-2 py-2 space-y-3">
            <div className="flex items-center gap-2 px-1 text-xs text-foreground-muted">
              <Spinner size="sm" className="text-foreground-muted" />
              <span>{t('sidePane.openFileLoading')}</span>
            </div>
            <div className="space-y-3 pt-1">
              {SKELETON_ROW_WIDTHS.map((w, i) => (
                <div key={`sk-${i}`} className="space-y-1.5">
                  <Skeleton className={`h-3 ${w}`} />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <span className="mb-3 text-foreground-muted"><Icon name="warning" size={32} /></span>
            <span className="text-sm text-destructive leading-relaxed">{error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <span className="mb-3 text-foreground-muted"><Icon name="open-file" size={28} /></span>
            <span className="text-sm text-foreground-muted">{t('sidePane.openFileEmpty')}</span>
          </div>
        ) : (
          filtered.map((file, idx) => (
            <button
              key={file.path}
              data-index={idx}
              onClick={() => onOpenFile(file.path)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`group relative w-full text-left px-3 py-2 pl-8 rounded-lg transition-colors ${
                idx === selectedIndex ? 'bg-selected' : 'hover:bg-surface-hover'
              }`}
            >
              {idx === selectedIndex && (
                <span className="absolute left-2 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-brand" />
              )}
              <div className="flex items-center gap-2">
                <Icon
                  name="file"
                  size={13}
                  className="shrink-0 text-foreground-muted transition-colors"
                />
                <span className="text-sm text-foreground truncate">{file.name}</span>
              </div>
              {/* 行背景是叠层底（选中 bg-selected / 悬停 hover:bg-surface-hover），
                  暗色下 muted 落在这两层上只有 ~4.32 / ~4.30:1，低于 4.5 ——
                  路径用标题级前景色（叠层底上 ≥8:1），不退回 muted。 */}
              <div className="text-xs text-foreground truncate font-mono mt-0.5 pl-5" title={file.path}>
                {file.path}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
