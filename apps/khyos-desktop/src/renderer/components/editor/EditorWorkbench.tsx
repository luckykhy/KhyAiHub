import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { EditorPendingItem } from '../../../shared/editorContract'
import { FileTree } from '../filetree/FileTree'
import { Icon } from '../ui/Icon'
import { EditorTabs, type EditorTabView } from './EditorTabs'
import { EditorSurface } from './EditorSurface'
import { PendingReviewPanel } from './PendingReviewPanel'
import { SearchPanel } from './SearchPanel'
import { EDITOR_BRIDGE_MISSING, editorBridge } from './editorApi'
import { baseName, normalizeFilePath, toDiskText, toModelUri } from './editorModels'

// 内建代码编辑器工作台（DESIGN-ARCH-210 M1）外壳。
// 状态归属：标签元数据与 Monaco 模型都在这层；AppLayout 只持有「当前是哪个
// 视图」和「有没有未保存内容」两个布尔，避免把 god file 再喂胖。
//
// 人机共用的写通道在 M2 收口（fileWriteService）；本文件只负责「人这一侧」
// 的读/改/存/冲突三态。

export interface EditorOpenRequest {
  filePath: string
  seq: number
}

interface EditorWorkbenchProps {
  visible: boolean
  request: EditorOpenRequest | null
  rootPath?: string
  onDirtyChange: (dirty: boolean) => void
  onBackToChat: () => void
}

interface Tab {
  filePath: string
  uri: string
  name: string
  /** null = 正在从磁盘读取 */
  content: string | null
  eol: 'lf' | 'crlf'
  bom: boolean
  mtimeMs: number
  /** 上次保存/加载时的 Monaco alternativeVersionId；-1 = 尚未建立基线 */
  savedVersionId: number
  dirty: boolean
  /** 磁盘在标签干净时被外部修改 → 自动重载；脏时只标记，不覆盖 */
  externalChanged: boolean
  gone: boolean
  error: string
}

const EMPTY_TAB = (filePath: string): Tab => ({
  filePath,
  uri: toModelUri(filePath),
  name: baseName(filePath),
  content: null,
  eol: 'lf',
  bom: false,
  mtimeMs: 0,
  savedVersionId: -1,
  dirty: false,
  externalChanged: false,
  gone: false,
  error: '',
})

export function EditorWorkbench({ visible, request, rootPath, onDirtyChange, onBackToChat }: EditorWorkbenchProps) {
  const api = useMemo(() => editorBridge(), [])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState('')
  const [root, setRoot] = useState(rootPath || '')
  const [pane, setPane] = useState<'tree' | 'search'>('tree')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState<{ filePath: string; diskMtimeMs?: number } | null>(null)
  const [pendingClose, setPendingClose] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [pending, setPending] = useState<EditorPendingItem[]>([])

  const tabsRef = useRef<Tab[]>([])
  const activePathRef = useRef('')
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const suppressChangeRef = useRef('')
  const statusTimerRef = useRef<number | null>(null)
  const lastRequestSeqRef = useRef(0)
  const anyDirtyRef = useRef(false)

  const commitTabs = useCallback((updater: (prev: Tab[]) => Tab[]) => {
    const next = updater(tabsRef.current)
    tabsRef.current = next
    setTabs(next)
  }, [])

  const updateTab = useCallback(
    (filePath: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => {
      commitTabs((prev) =>
        prev.map((tab) =>
          tab.filePath === filePath ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab,
        ),
      )
    },
    [commitTabs],
  )

  const showStatus = useCallback((text: string) => {
    setStatus(text)
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current)
    statusTimerRef.current = window.setTimeout(() => {
      setStatus('')
      statusTimerRef.current = null
    }, 4000)
  }, [])

  useEffect(() => () => {
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current)
  }, [])

  // 工作区根：调用方（AppLayout）给会话级根；没有则回退主进程 cwd
  useEffect(() => {
    if (rootPath) {
      setRoot(rootPath)
      return
    }
    if (!api?.getWorkspacePath) return
    void api.getWorkspacePath().then((p) => {
      if (typeof p === 'string' && p) setRoot(p)
    })
  }, [api, rootPath])

  const reloadFromDisk = useCallback(
    async (filePath: string, reason: 'manual' | 'external' = 'manual') => {
      if (!api) {
        updateTab(filePath, { error: EDITOR_BRIDGE_MISSING, content: '' })
        return
      }
      const tab = tabsRef.current.find((t) => t.filePath === filePath)
      if (!tab) return
      const res = await api.editorRead(filePath)
      if (!res.ok) {
        updateTab(filePath, {
          content: '',
          error: res.error || `读取 ${tab.name} 失败：主进程无响应，请重试`,
          gone: res.state === 'missing',
          dirty: false,
        })
        setConflict(null)
        return
      }
      const content = typeof res.content === 'string' ? res.content : ''
      const monaco = monacoRef.current
      const model = monaco ? monaco.editor.getModel(monaco.Uri.parse(tab.uri)) : null
      let savedVersionId = -1
      if (model && !model.isDisposed()) {
        suppressChangeRef.current = filePath
        model.setValue(content)
        suppressChangeRef.current = ''
        savedVersionId = model.getAlternativeVersionId()
      }
      updateTab(filePath, {
        content,
        eol: res.eol ?? 'lf',
        bom: !!res.bom,
        mtimeMs: res.mtimeMs ?? 0,
        savedVersionId,
        dirty: false,
        externalChanged: false,
        gone: false,
        error: '',
      })
      setConflict(null)
      showStatus(
        `${reason === 'external' ? '检测到外部修改：已从磁盘重载' : '已从磁盘重载'} ${tab.name}（${content ? content.split('\n').length : 0} 行）`,
      )
    },
    [api, showStatus, updateTab],
  )

  const openFile = useCallback(
    async (rawPath: string) => {
      if (!rawPath) return
      const filePath = normalizeFilePath(rawPath)
      activePathRef.current = filePath
      setActivePath(filePath)
      if (tabsRef.current.some((t) => t.filePath === filePath)) return
      commitTabs((prev) => [...prev, EMPTY_TAB(filePath)])
      if (!api) {
        updateTab(filePath, { content: '', error: EDITOR_BRIDGE_MISSING })
        return
      }
      const res = await api.editorRead(filePath)
      if (!res.ok) {
        updateTab(filePath, {
          content: '',
          error: res.error || `读取 ${baseName(filePath)} 失败：主进程无响应，请重试`,
        })
        return
      }
      updateTab(filePath, {
        content: typeof res.content === 'string' ? res.content : '',
        eol: res.eol ?? 'lf',
        bom: !!res.bom,
        mtimeMs: res.mtimeMs ?? 0,
        error: '',
      })
    },
    [api, commitTabs, updateTab],
  )

  // 外部打开请求（侧栏点文件 / 命令面板 / 聊天里的文件链接）：seq 去重，
  // 同一请求重复渲染不重复读盘
  useEffect(() => {
    if (!request || request.seq === lastRequestSeqRef.current) return
    lastRequestSeqRef.current = request.seq
    void openFile(request.filePath)
  }, [openFile, request])

  const adoptModelBaseline = useCallback(
    (instance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
      const model = instance.getModel()
      if (!model) return
      const key = model.uri.toString()
      const tab = tabsRef.current.find((t) => monaco.Uri.parse(t.uri).toString() === key)
      if (tab && tab.savedVersionId === -1) {
        updateTab(tab.filePath, { savedVersionId: model.getAlternativeVersionId() })
      }
    },
    [updateTab],
  )

  const handleEditorMount = useCallback(
    (instance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
      editorRef.current = instance
      monacoRef.current = monaco
      instance.onDidChangeModel(() => adoptModelBaseline(instance, monaco))
      adoptModelBaseline(instance, monaco)
    },
    [adoptModelBaseline],
  )

  // 脏判定走 Monaco 的 alternativeVersionId：撤销回保存点时自动变干净，
  // 不做字符串比对（大文件每次按键都全量比较）
  const handleContentChange = useCallback(() => {
    const filePath = activePathRef.current
    const instance = editorRef.current
    if (!filePath || !instance || suppressChangeRef.current === filePath) return
    const model = instance.getModel()
    const tab = tabsRef.current.find((t) => t.filePath === filePath)
    if (!model || !tab) return
    const version = model.getAlternativeVersionId()
    if (tab.savedVersionId === -1) {
      updateTab(filePath, { savedVersionId: version })
      return
    }
    const dirty = version !== tab.savedVersionId
    if (dirty !== tab.dirty) updateTab(filePath, { dirty })
  }, [updateTab])

  const saveTab = useCallback(
    async (filePath: string, opts?: { force?: boolean }): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.filePath === filePath)
      const instance = editorRef.current
      const monaco = monacoRef.current
      if (!api) {
        setSaveError(EDITOR_BRIDGE_MISSING)
        return false
      }
      if (!tab || tab.content === null || !instance || !monaco) return false
      const model = instance.getModel()
      if (!model || model.uri.toString() !== monaco.Uri.parse(tab.uri).toString()) {
        setSaveError(`保存失败：${tab.name} 当前不在编辑器里，请先切到该标签再保存`)
        return false
      }
      setSaving(true)
      setSaveError('')
      const res = await api.editorWrite(filePath, toDiskText(model.getValue(), tab.eol, tab.bom), opts?.force ? undefined : tab.mtimeMs)
      setSaving(false)
      if (res.ok) {
        updateTab(filePath, {
          mtimeMs: res.mtimeMs ?? tab.mtimeMs,
          savedVersionId: model.getAlternativeVersionId(),
          dirty: false,
          externalChanged: false,
          gone: false,
        })
        setConflict(null)
        showStatus(`已保存 ${tab.name}（${model.getLineCount()} 行）`)
        return true
      }
      if (res.state === 'conflict') {
        setConflict({ filePath, diskMtimeMs: res.diskMtimeMs })
        return false
      }
      setSaveError(res.error || `保存 ${tab.name} 失败：主进程无响应，请重试`)
      return false
    },
    [api, showStatus, updateTab],
  )

  const disposeModelLater = useCallback((uri: string) => {
    window.setTimeout(() => {
      const monaco = monacoRef.current
      if (!monaco) return
      if (tabsRef.current.some((t) => t.uri === uri)) return
      const model = monaco.editor.getModel(monaco.Uri.parse(uri))
      if (model && !model.isDisposed()) model.dispose()
    }, 0)
  }, [])

  const closeTabNow = useCallback(
    (filePath: string) => {
      const prev = tabsRef.current
      const tab = prev.find((t) => t.filePath === filePath)
      const index = prev.findIndex((t) => t.filePath === filePath)
      const next = prev.filter((t) => t.filePath !== filePath)
      tabsRef.current = next
      setTabs(next)
      if (activePathRef.current === filePath) {
        const fallback = next[Math.min(index, next.length - 1)]
        const nextActive = fallback ? fallback.filePath : ''
        activePathRef.current = nextActive
        setActivePath(nextActive)
      }
      if (tab) disposeModelLater(tab.uri)
      setConflict((c) => (c?.filePath === filePath ? null : c))
      setSaveError('')
      setPendingClose((p) => (p === filePath ? null : p))
    },
    [disposeModelLater],
  )

  const requestClose = useCallback(
    (filePath: string) => {
      const tab = tabsRef.current.find((t) => t.filePath === filePath)
      if (!tab) return
      if (tab.dirty) {
        setPendingClose(filePath)
        return
      }
      closeTabNow(filePath)
    },
    [closeTabNow],
  )

  // 标签集合变化 → 主进程只监听这些文件的父目录（≤64 个，超了如实报 dropped）
  const watchKey = tabs.map((t) => t.filePath).join('\n')
  useEffect(() => {
    if (!api) return
    void api.editorWatchSet(tabsRef.current.map((t) => t.filePath))
  }, [api, watchKey])

  useEffect(
    () => () => {
      if (api) void api.editorWatchSet([])
    },
    [api],
  )

  // 磁盘变更：干净 → 自动重载；脏 → 只标记（不覆盖人的未保存内容）
  useEffect(() => {
    if (!api) return
    return api.onEditorFileChanged((evt) => {
      const filePath = normalizeFilePath(evt.filePath)
      const tab = tabsRef.current.find((t) => t.filePath === filePath)
      if (!tab) return
      if (evt.state === 'gone') {
        updateTab(filePath, { gone: true })
        showStatus(`磁盘上的 ${tab.name} 已被删除或移走：保存会失败`)
        return
      }
      if (tab.dirty) {
        if (!tab.externalChanged) updateTab(filePath, { externalChanged: true })
        showStatus(`${tab.name} 在磁盘上已变化（外部修改）：你的未保存内容仍在`)
        return
      }
      void reloadFromDisk(filePath, 'external')
    })
  }, [api, reloadFromDisk, showStatus, updateTab])

  // AI 改动待审（M3）：打开集合由 watch-set 那条通道顺带告诉 host；这里只维护
  // 「有哪几张待审卡片」与提交决定。卡片在 host 收束（接受/拒绝/超时）后消失。
  useEffect(() => {
    if (!api?.editorPendingList || !api.onEditorPending || !api.onEditorPendingSettled) return
    let alive = true
    void api.editorPendingList().then((list) => {
      if (!alive || !Array.isArray(list)) return
      setPending(list.map((item) => ({ ...item, filePath: normalizeFilePath(item.filePath) })))
    })
    const offAdd = api.onEditorPending((item) => {
      const normalized = { ...item, filePath: normalizeFilePath(item.filePath) }
      setPending((prev) => [...prev.filter((p) => p.id !== normalized.id), normalized])
    })
    const offSettled = api.onEditorPendingSettled((evt) => {
      setPending((prev) => prev.filter((p) => p.id !== evt.id))
      showStatus(evt.ok ? '已批准 AI 改动：正在写入磁盘' : evt.error || 'AI 改动未获批准：磁盘保持原样')
    })
    return () => {
      alive = false
      offAdd()
      offSettled()
    }
  }, [api, showStatus])

  const decidePending = useCallback(
    (id: string, decision: { accept: boolean; acceptedHunks?: number[] }) => {
      if (!api?.editorPendingDecision) return
      void api
        .editorPendingDecision({ id, ...decision })
        .then((res) => {
          if (res?.ok) setPending((prev) => prev.filter((p) => p.id !== id))
          else showStatus(res?.error || '提交待审决定失败：主进程无响应，请重试')
        })
        .catch(() => showStatus('提交待审决定失败：与主进程的连接已断开，请重启应用'))
    },
    [api, showStatus],
  )

  const dirtyPaths = useMemo(() => new Set(tabs.filter((t) => t.dirty).map((t) => t.filePath)), [tabs])

  useEffect(() => {
    const anyDirty = tabs.some((t) => t.dirty)
    if (anyDirtyRef.current === anyDirty) return
    anyDirtyRef.current = anyDirty
    onDirtyChange(anyDirty)
  }, [onDirtyChange, tabs])

  const openCreateDialog = useCallback(() => {
    setCreateName('')
    setCreateError('')
    setCreating(true)
  }, [])

  const submitCreate = useCallback(async () => {
    const name = createName.trim()
    if (!name) {
      setCreateError('文件名不能为空')
      return
    }
    if (!api) {
      setCreateError(EDITOR_BRIDGE_MISSING)
      return
    }
    if (!root) {
      setCreateError('没有可用的目标目录：请先打开一个工作区')
      return
    }
    setCreateBusy(true)
    const res = await api.editorCreateFile(root, name)
    setCreateBusy(false)
    if (!res.ok || !res.filePath) {
      setCreateError(res.error || `新建 ${name} 失败：主进程无响应，请重试`)
      return
    }
    setCreating(false)
    setCreateName('')
    setRefreshToken((n) => n + 1)
    showStatus(`已新建 ${baseName(res.filePath)}（${root}）`)
    await openFile(res.filePath)
  }, [api, openFile, root, showStatus])

  const activeTab = tabs.find((t) => t.filePath === activePath) ?? null

  const tabViews: EditorTabView[] = tabs.map((t) => ({
    filePath: t.filePath,
    name: t.name,
    dirty: t.dirty,
    blocked: !!t.error,
  }))

  const conflictIsActive = conflict && activeTab && conflict.filePath === activeTab.filePath

  return (
    <div className={visible ? 'flex flex-1 min-h-0 min-w-0' : 'hidden'}>
      <aside className="w-60 shrink-0 border-r border-border flex flex-col min-h-0 bg-surface/30">
        <div className="flex items-center gap-1 px-2 pt-2 pb-1 shrink-0">
          <button
            onClick={() => setPane('tree')}
            aria-pressed={pane === 'tree'}
            className={`px-2 h-6 rounded-md text-[11px] transition-colors ${
              pane === 'tree' ? 'bg-surface-hover text-foreground' : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            文件
          </button>
          <button
            onClick={() => setPane('search')}
            aria-pressed={pane === 'search'}
            className={`px-2 h-6 rounded-md text-[11px] transition-colors ${
              pane === 'search' ? 'bg-surface-hover text-foreground' : 'text-foreground-muted hover:text-foreground'
            }`}
          >
            搜索
          </button>
          <div className="flex-1" />
          <button
            onClick={openCreateDialog}
            title="新建文件"
            aria-label="新建文件"
            className="w-7 h-7 rounded-md flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {pane === 'tree' ? (
            <FileTree
              onOpenFile={(p) => void openFile(p)}
              rootPath={rootPath}
              refreshToken={refreshToken}
              onCreateFile={openCreateDialog}
            />
          ) : (
            <SearchPanel rootPath={root || rootPath} onOpenHit={(p) => void openFile(p)} />
          )}
        </div>
      </aside>

      <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-background">
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border">
          <Icon name="code" size={13} className="text-foreground-muted shrink-0" />
          <span className="text-xs font-medium text-foreground shrink-0">代码编辑器</span>
          <span className="text-[11px] text-foreground-subtle truncate" title={root}>
            {root || '未打开工作区'}
          </span>
          <div className="flex-1" />
          {status && (
            <span className="text-[11px] text-foreground-muted truncate max-w-[45%]" title={status}>
              {status}
            </span>
          )}
          <button
            onClick={onBackToChat}
            className="shrink-0 px-2 h-6 rounded-md text-[11px] text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            title="回到对话视图（编辑器标签与未保存内容保留）"
          >
            返回对话
          </button>
        </div>

        <EditorTabs
          tabs={tabViews}
          activePath={activePath}
          onSelect={(p) => {
            activePathRef.current = p
            setActivePath(p)
            setSaveError('')
          }}
          onClose={requestClose}
        />

        {saveError && (
          <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-destructive/10 shrink-0">
            <Icon name="error" size={13} className="text-destructive shrink-0 mt-0.5" />
            <span className="text-xs text-destructive leading-relaxed flex-1 min-w-0">{saveError}</span>
            <button
              onClick={() => setSaveError('')}
              className="shrink-0 text-destructive/80 hover:text-destructive"
              title="关闭提示"
              aria-label="关闭提示"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}

        {activeTab && (conflictIsActive || (activeTab.dirty && activeTab.externalChanged)) && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-warning/10 shrink-0 flex-wrap">
            <Icon name="warning" size={13} className="text-warning shrink-0" />
            <span className="text-xs text-warning leading-relaxed flex-1 min-w-0">
              磁盘上的 {activeTab.name} 已变化（外部修改）：直接覆盖会丢掉对方的改动
            </span>
            <button
              onClick={() => void saveTab(activeTab.filePath, { force: true })}
              className="shrink-0 px-2 h-6 rounded-md text-xs bg-warning/15 text-warning hover:bg-warning/25 transition-colors"
            >
              覆盖写入
            </button>
            <button
              onClick={() => void reloadFromDisk(activeTab.filePath)}
              className="shrink-0 px-2 h-6 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              重新加载（丢弃我的修改）
            </button>
          </div>
        )}

        {activeTab && activeTab.gone && !activeTab.error && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-warning/10 shrink-0">
            <Icon name="warning" size={13} className="text-warning shrink-0" />
            <span className="text-xs text-warning leading-relaxed flex-1 min-w-0">
              {activeTab.name} 已不在磁盘上：保存会失败，请确认是否被其他程序删除或移走
            </span>
          </div>
        )}

        <div className="flex-1 min-h-0 flex flex-col">
          {!activeTab ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-foreground-muted">
              <Icon name="code" size={28} />
              <span className="text-sm">还没有打开文件</span>
              <span className="text-xs text-foreground-subtle">从左侧文件树选择文件，或新建一个</span>
              <button
                onClick={openCreateDialog}
                className="mt-1 px-3 h-7 rounded-md text-xs bg-surface-hover text-foreground hover:bg-surface-hover/80 transition-colors"
              >
                新建文件
              </button>
            </div>
          ) : activeTab.error ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <Icon name="warning" size={26} className="text-warning" />
              <span className="text-sm text-destructive leading-relaxed max-w-lg">{activeTab.error}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void reloadFromDisk(activeTab.filePath)}
                  className="px-3 h-7 rounded-md text-xs bg-surface-hover text-foreground hover:bg-surface-hover/80 transition-colors"
                >
                  重新读取
                </button>
                <button
                  onClick={() => closeTabNow(activeTab.filePath)}
                  className="px-3 h-7 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                >
                  关闭标签
                </button>
              </div>
            </div>
          ) : activeTab.content === null ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-xs text-foreground-muted">
              <Icon name="file" size={14} />
              读取 {activeTab.name}…
            </div>
          ) : (
            <EditorSurface
              tab={{
                filePath: activeTab.filePath,
                uri: activeTab.uri,
                content: activeTab.content,
                eol: activeTab.eol,
                bom: activeTab.bom,
              }}
              saving={saving}
              onMount={handleEditorMount}
              onContentChange={handleContentChange}
              onSaveShortcut={() => void saveTab(activeTab.filePath)}
            />
          )}
        </div>
      </section>

      <PendingReviewPanel items={pending} dirtyPaths={dirtyPaths} onDecide={decidePending} />

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="新建文件">
          <div className="w-[380px] rounded-xl border border-border bg-background shadow-xl p-4">
            <div className="text-sm font-medium text-foreground mb-1">新建文件</div>
            <div className="text-[11px] text-foreground-subtle mb-3 break-all">目标目录：{root || '未打开工作区'}</div>
            <input
              autoFocus
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="例如 notes.md"
              aria-label="新文件名"
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:border-input-border-focused focus:outline-none transition-colors"
            />
            {createError && <div className="mt-2 text-xs text-destructive leading-relaxed">{createError}</div>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setCreating(false)}
                className="px-3 h-7 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => void submitCreate()}
                disabled={createBusy}
                className="px-3 h-7 rounded-md text-xs bg-brand/90 text-white hover:bg-brand disabled:opacity-50 transition-colors"
              >
                {createBusy ? '创建中：正在写入新文件…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingClose && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="关闭未保存的标签">
          <div className="w-[420px] rounded-xl border border-border bg-background shadow-xl p-4">
            <div className="text-sm font-medium text-foreground mb-2">关闭 {baseName(pendingClose)}？</div>
            <div className="text-xs text-foreground-muted leading-relaxed mb-4">
              该文件有未保存的修改：关闭会丢掉这些改动。
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingClose(null)}
                className="px-3 h-7 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => closeTabNow(pendingClose)}
                className="px-3 h-7 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors"
              >
                不保存并关闭
              </button>
              <button
                onClick={() => {
                  const target = pendingClose
                  void saveTab(target).then((ok) => {
                    if (ok) closeTabNow(target)
                    else setPendingClose(null)
                  })
                }}
                className="px-3 h-7 rounded-md text-xs bg-brand/90 text-white hover:bg-brand transition-colors"
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
