import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SEARCH_BUDGET_MS,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_HITS,
  SEARCH_MAX_HIT_FILES,
  type EditorSearchHit,
  type EditorSearchProgress,
  type EditorSearchResult,
} from '../../../shared/editorContract'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { EDITOR_BRIDGE_MISSING, editorBridge } from './editorApi'
import { relativeToRoot } from './editorModels'

interface SearchPanelProps {
  rootPath?: string
  onOpenHit: (filePath: string) => void
}

interface HitGroup {
  filePath: string
  label: string
  hits: EditorSearchHit[]
}

// 搜索结果以「文件分组」呈现（同 VS Code 的搜索侧栏），点击任意命中打开文件。
// 不做跳行 —— 首期明确不做（见 DESIGN-ARCH-210 的不做清单）。

export function SearchPanel({ rootPath, onOpenHit }: SearchPanelProps) {
  const api = useMemo(() => editorBridge(), [])
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<EditorSearchProgress | null>(null)
  const [result, setResult] = useState<EditorSearchResult | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const activeIdRef = useRef('')

  useEffect(() => {
    if (!api) {
      setError(EDITOR_BRIDGE_MISSING)
      return
    }
    return api.onEditorSearchProgress((p) => {
      if (p.searchId === activeIdRef.current) setProgress(p)
    })
  }, [api])

  // 面板卸载时把在跑的搜索收掉：不取消的话主进程会继续扫完整个工作区
  useEffect(() => () => {
    if (activeIdRef.current && api) void api.editorSearchCancel(activeIdRef.current)
  }, [api])

  const run = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setError('搜索内容为空：请输入要查找的文本')
      return
    }
    if (!api) {
      setError(EDITOR_BRIDGE_MISSING)
      return
    }
    if (activeIdRef.current) void api.editorSearchCancel(activeIdRef.current)
    const searchId = `editor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    activeIdRef.current = searchId
    setRunning(true)
    setResult(null)
    setProgress(null)
    setError('')
    setNotice('')
    const res = await api.editorSearch(q, { caseSensitive, root: rootPath, searchId })
    if (activeIdRef.current !== searchId) return
    activeIdRef.current = ''
    setRunning(false)
    if (!res.ok) {
      setError(res.error || '搜索失败：主进程无响应，请重试')
      return
    }
    setResult(res)
  }, [api, caseSensitive, query, rootPath])

  const cancel = useCallback(() => {
    if (!api || !activeIdRef.current) return
    void api.editorSearchCancel(activeIdRef.current)
    setNotice('已发送取消请求：正在让主进程收尾，已扫到的结果会保留')
  }, [api])

  const groups = useMemo<HitGroup[]>(() => {
    if (!result) return []
    const map = new Map<string, EditorSearchHit[]>()
    for (const hit of result.hits) {
      const list = map.get(hit.filePath)
      if (list) list.push(hit)
      else map.set(hit.filePath, [hit])
    }
    return [...map.entries()].map(([filePath, hits]) => ({
      filePath,
      label: relativeToRoot(filePath, rootPath || ''),
      hits,
    }))
  }, [result, rootPath])

  const progressText = progress
    ? `扫描 ${progress.scannedFiles}/${progress.totalFiles} 个文件 · 命中 ${progress.hitCount} 处（${progress.hitFiles} 个文件）`
    : '枚举工作区文件列表：尚未返回文件计数'

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 pt-2 pb-2 space-y-2 shrink-0 border-b border-border">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
            placeholder="搜索工作区内容…"
            aria-label="搜索工作区内容"
            className="flex-1 min-w-0 bg-input border border-input-border rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-muted focus:border-input-border-focused focus:outline-none transition-colors"
          />
          <button
            onClick={() => setCaseSensitive((v) => !v)}
            aria-pressed={caseSensitive}
            title="区分大小写"
            className={`h-7 px-1.5 rounded-md text-[11px] border transition-colors ${
              caseSensitive
                ? 'border-brand/60 bg-brand/15 text-brand'
                : 'border-input-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            Aa
          </button>
          <button
            onClick={() => (running ? cancel() : void run())}
            title={running ? '取消搜索' : '开始搜索'}
            aria-label={running ? '取消搜索' : '开始搜索'}
            className="w-7 h-7 rounded-md flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
          >
            {running ? <Icon name="stop" size={12} /> : <Icon name="search" size={13} />}
          </button>
        </div>
        {(running || progress || notice) && (
          <div className="flex items-center gap-1.5 text-[11px] text-foreground-muted">
            {running && <Spinner size="sm" className="text-foreground-muted shrink-0" />}
            <span className="truncate" title={notice || progressText}>
              {notice || progressText}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto py-1">
        {error ? (
          <div className="flex items-start gap-2 px-3 py-3 text-xs text-destructive leading-relaxed">
            <Icon name="error" size={13} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : result ? (
          result.hits.length === 0 ? (
            <div className="px-3 py-4 text-xs text-foreground-muted leading-relaxed">
              {result.truncated && result.reason
                ? `没有命中，但搜索未完成：${result.reason}`
                : `没有命中：已扫描 ${result.scannedFiles}/${result.totalFiles} 个文件`}
            </div>
          ) : (
            <div className="pb-2">
              <div className="px-3 py-1.5 text-[11px] text-foreground-muted">
                命中 {result.hits.length} 处（{groups.length} 个文件）· 扫描 {result.scannedFiles}/{result.totalFiles} 个文件
              </div>
              {result.skippedFiles > 0 && (
                <div className="px-3 pb-1 text-[11px] text-foreground-subtle">
                  {result.skippedFiles} 个文件因过大或含二进制内容被跳过
                </div>
              )}
              {result.truncated && result.reason && (
                <div className="mx-3 mb-2 px-2 py-1.5 rounded-md bg-warning/10 text-[11px] text-warning leading-relaxed">
                  {result.reason}
                </div>
              )}
              {groups.map((group) => (
                <div key={group.filePath} className="mb-1">
                  <button
                    onClick={() => onOpenHit(group.filePath)}
                    title={group.filePath}
                    className="w-full flex items-center gap-1.5 px-3 py-1 text-left text-xs text-foreground hover:bg-surface-hover transition-colors"
                  >
                    <Icon name="file" size={12} className="text-foreground-subtle shrink-0" />
                    <span className="truncate">{group.label}</span>
                    <span className="text-foreground-subtle tabular-nums shrink-0">{group.hits.length}</span>
                  </button>
                  {group.hits.map((hit, idx) => (
                    <button
                      key={`${hit.line}:${hit.column}:${idx}`}
                      onClick={() => onOpenHit(group.filePath)}
                      title={`${group.filePath}:${hit.line}:${hit.column}`}
                      className="w-full flex items-baseline gap-2 pl-8 pr-3 py-0.5 text-left text-[11px] text-foreground-muted hover:bg-surface-hover hover:text-foreground transition-colors"
                    >
                      <span className="tabular-nums text-foreground-subtle shrink-0 w-8 text-right">{hit.line}</span>
                      <span className="truncate font-mono">{hit.preview}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )
        ) : running ? (
          <div className="px-3 py-4 text-xs text-foreground-muted">{progressText}</div>
        ) : (
          <div className="px-3 py-4 text-xs text-foreground-muted leading-relaxed">
            输入文本后回车开始搜索。搜索按四个上限有界收尾（命中 {SEARCH_MAX_HITS} 处 /{' '}
            {SEARCH_MAX_HIT_FILES} 个文件 / 单文件 {Math.round(SEARCH_MAX_FILE_BYTES / 1024)} KiB /{' '}
            {SEARCH_BUDGET_MS / 1000} 秒），到点会如实报告还有多少文件未扫描。
          </div>
        )}
      </div>
    </div>
  )
}
