// khy-canary: Khy-20261103-341-EDT7QX2K
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'

// 内置代码编辑器（查看面板编辑态，codeEditor.* 文案）：
// Monaco 内核 —— loader 本地化与 worker 接线在 monacoSetup.ts（禁 CDN）。
// 保存走 codeEditor:write（主进程：已存在文件 + 工作区白名单 + mtime 冲突
// 拒写 + tmp/rename 原子写）；运行复用 pty 通道，按扩展名映射 node/python，
// 输出回显在底部输出条（不另开终端标签，会话数受 MAX_SESSIONS=8 限制，
// 卸载时收回自己申请的会话）。
//
// CRLF：Monaco 模型内部统一按 \n 存行，直接 getValue() 保存会把整个文件
// 的 CRLF 静默改成 LF（每一行都进 diff）。加载时探测行尾、保存时原样还原。

interface CodeEditorPaneProps {
  filePath: string
  // 脏状态外抛：AppLayout 据此给标签打脏点、关标签前弹确认
  onDirtyChange: (dirty: boolean) => void
}

interface ViewerPayload {
  ok: boolean
  state?: string
  content?: string
  mtimeMs?: number
  error?: string
}

interface WriteResult {
  ok: boolean
  mtimeMs?: number
  state?: string
  error?: string
}

// 可运行扩展名 → 解释器命令。文件路径统一双引号包裹（空格路径）。
const RUNNERS: Record<string, string> = {
  js: 'node',
  mjs: 'node',
  cjs: 'node',
  py: 'python',
}

// 扩展名 → Monaco 语言 id（未命中的落 plaintext：纯文本也能编辑）
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  py: 'python',
  md: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'html', xml: 'xml', svg: 'xml',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shell', ps1: 'powershell', bat: 'bat',
  sql: 'sql',
  toml: 'ini', ini: 'ini',
}

interface PtyApi {
  ptyCreate?: (opts?: { cols?: number; rows?: number; cwd?: string }) => Promise<{ ok: boolean; id?: string; error?: string }>
  ptyWrite?: (id: string, data: string) => Promise<unknown>
  ptyKill?: (id: string) => Promise<unknown>
  onPtyData?: (cb: (payload: { id: string; data: string }) => void) => () => void
  onPtyExit?: (cb: (payload: { id: string; code: number }) => void) => () => void
  codeViewerRead?: (filePath: string) => Promise<ViewerPayload>
  codeEditorWrite?: (filePath: string, content: string, baseMtimeMs?: number) => Promise<WriteResult>
}

const ptyApi = () => (window as unknown as { __KHYOS__?: PtyApi }).__KHYOS__

export function CodeEditorPane({ filePath, onDirtyChange }: CodeEditorPaneProps) {
  const { t } = useTranslation()
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const runner = RUNNERS[ext]
  const language = LANGUAGES[ext] ?? 'plaintext'

  const [content, setContent] = useState<string | null>(null)
  const [savedContent, setSavedContent] = useState('')
  const [mtimeMs, setMtimeMs] = useState(0)
  const [crlf, setCrlf] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [status, setStatus] = useState('')

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const outputRef = useRef<HTMLPreElement | null>(null)
  const statusTimer = useRef<number | null>(null)
  const [output, setOutput] = useState('')
  const [outputOpen, setOutputOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)

  // 读取走只读预览通道（四态契约 + mtime 基线），与查看态同一来源
  useEffect(() => {
    let cancelled = false
    const api = ptyApi()
    if (!api?.codeViewerRead) {
      setLoadError('文件读取通道不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    api.codeViewerRead(filePath).then((res) => {
      if (cancelled) return
      // empty 态（0 字节文件）也放行：空文件照样能编辑，按空内容起手
      const readable = res?.ok === true || res?.state === 'empty'
      if (!readable) {
        setLoadError(`无法读取 ${fileName}：${res?.error || '文件不存在或不可访问'}`)
        return
      }
      const text = typeof res.content === 'string' ? res.content : ''
      setContent(text)
      setSavedContent(text)
      setMtimeMs(res.mtimeMs ?? 0)
      setCrlf(text.includes('\r\n'))
    }).catch(() => {
      if (!cancelled) setLoadError(`读取 ${fileName} 失败：主进程无响应，请重启应用后重试`)
    })
    return () => { cancelled = true }
  }, [filePath, fileName])

  const flashStatus = useCallback((text: string) => {
    setStatus(text)
    if (statusTimer.current) window.clearTimeout(statusTimer.current)
    // 短 UI 重置定时器（≤5s，只清状态文字），Rule 3 合法例外
    statusTimer.current = window.setTimeout(() => setStatus(''), 4000)
  }, [])

  useEffect(() => () => {
    if (statusTimer.current) window.clearTimeout(statusTimer.current)
  }, [])

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  const handleChange = useCallback((value: string | undefined) => {
    const next = value ?? ''
    setContent(next)
    setDirty(next !== savedContent)
  }, [savedContent])

  const save = useCallback(async (overwrite = false) => {
    const value = editorRef.current?.getValue() ?? content ?? ''
    const payload = crlf ? value.replace(/\r?\n/g, '\r\n') : value
    const api = ptyApi()
    if (!api?.codeEditorWrite) {
      setSaveError('保存通道不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    setSaving(true)
    setSaveError('')
    flashStatus(t('codeEditor.saving', { file: fileName }))
    try {
      const r = await api.codeEditorWrite(filePath, payload, overwrite ? undefined : mtimeMs)
      if (r?.ok) {
        setMtimeMs(r.mtimeMs ?? mtimeMs)
        setSavedContent(value)
        setDirty(false)
        setConflict(false)
        flashStatus(overwrite ? t('codeEditor.overwriteDone', { file: fileName }) : t('codeEditor.saved', { file: fileName }))
      } else if (r?.state === 'conflict') {
        // 磁盘已被外部改动：不写，把选择权交给人（覆盖 or 重载）
        setConflict(true)
        setStatus('')
      } else {
        setSaveError(t('codeEditor.saveFailed', { error: r?.error || '未知错误' }))
      }
    } catch (err) {
      setSaveError(t('codeEditor.saveFailed', { error: String(err) }))
    } finally {
      setSaving(false)
    }
  }, [content, crlf, filePath, fileName, mtimeMs, t, flashStatus])

  const reload = useCallback(async () => {
    const api = ptyApi()
    if (!api?.codeViewerRead) return
    try {
      const res = await api.codeViewerRead(filePath)
      if (!res?.ok || typeof res.content !== 'string') {
        setSaveError(`重新加载失败：${res?.error || '文件不可读'}`)
        return
      }
      setContent(res.content)
      setSavedContent(res.content)
      setMtimeMs(res.mtimeMs ?? 0)
      setCrlf(res.content.includes('\r\n'))
      setDirty(false)
      setConflict(false)
      setSaveError('')
      flashStatus(t('codeEditor.reloaded', { file: fileName }))
    } catch (err) {
      setSaveError(`重新加载失败：${String(err)}`)
    }
  }, [filePath, fileName, t, flashStatus])

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    editor.addAction({
      id: 'khyos.saveFile',
      label: t('codeEditor.save'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => { void save() },
    })
  }, [save, t])

  // ── 运行到终端（pty 复用）────────────────────────────────────────
  const run = useCallback(async () => {
    if (!runner) return
    const api = ptyApi()
    if (!api?.ptyCreate || !api.ptyWrite) {
      setSaveError('终端通道不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    setOutput('')
    setExitCode(null)
    setOutputOpen(true)
    setRunning(true)
    setSaveError('')
    flashStatus(t('codeEditor.running', { file: fileName }))
    const dir = filePath.replace(/[\\/][^\\/]*$/, '') || filePath
    const res = await api.ptyCreate({ cwd: dir, cols: 100, rows: 24 })
    if (!res?.ok || !res.id) {
      setRunning(false)
      setOutput(t('codeEditor.runFailed', { error: res?.error || 'PTY 启动失败' }))
      return
    }
    ptyIdRef.current = res.id
    api.ptyWrite(res.id, `${runner} "${filePath}"\r`)
  }, [filePath, fileName, runner, t, flashStatus])

  const stop = useCallback(() => {
    const id = ptyIdRef.current
    if (id) ptyApi()?.ptyKill?.(id)
    ptyIdRef.current = null
    setRunning(false)
    flashStatus(t('codeEditor.stop'))
  }, [t, flashStatus])

  useEffect(() => {
    const api = ptyApi()
    if (!api?.onPtyData || !api?.onPtyExit) return
    const offData = api.onPtyData(({ id, data }) => {
      if (id !== ptyIdRef.current) return
      setOutput((o) => o + data)
    })
    const offExit = api.onPtyExit(({ id, code }) => {
      if (id !== ptyIdRef.current) return
      ptyIdRef.current = null
      setRunning(false)
      setExitCode(typeof code === 'number' ? code : null)
    })
    return () => { offData(); offExit() }
  }, [])

  // 卸载时收回自己申请的 pty 会话（MAX_SESSIONS=8，漏杀会占额度）
  useEffect(() => () => {
    const id = ptyIdRef.current
    if (id) ptyApi()?.ptyKill?.(id)
  }, [])

  useEffect(() => {
    const el = outputRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <Icon name="error" size={22} className="text-destructive" />
        <span className="text-sm text-destructive leading-relaxed">{loadError}</span>
      </div>
    )
  }

  if (content === null) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-foreground-muted">
        <Spinner size="sm" className="text-foreground-muted" />
        <span>{t('codeEditor.loading', { file: fileName })}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 工具栏：保存 / 运行 / 输出开关 + 状态（动作 + 目标，Rule 2） */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        {dirty && (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-warning/15 text-warning">
            {t('codeEditor.dirty')}
          </span>
        )}
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${
            dirty && !saving
              ? 'bg-brand-subtle text-brand hover:bg-brand-subtle/80'
              : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
          title={`${t('codeEditor.save')}（Ctrl+S）`}
        >
          <Icon name="save" size={12} />
          {t('codeEditor.save')}
        </button>
        {runner && (
          running ? (
            <button
              onClick={stop}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
              title={t('codeEditor.stop')}
            >
              <Icon name="stop" size={12} />
              {t('codeEditor.stop')}
            </button>
          ) : (
            <button
              onClick={() => void run()}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
              title={`${t('codeEditor.run')}：${runner} "${fileName}"`}
            >
              <Icon name="play" size={12} />
              {t('codeEditor.run')}
            </button>
          )
        )}
        <button
          onClick={() => setOutputOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${
            outputOpen
              ? 'bg-brand-subtle text-brand'
              : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
          }`}
          title={outputOpen ? t('codeEditor.outputHide') : t('codeEditor.outputShow')}
          aria-pressed={outputOpen}
        >
          <Icon name="terminal" size={12} />
          {t('codeEditor.output')}
        </button>
        <div className="flex-1" />
        {status && <span className="text-xs text-foreground-muted truncate max-w-[60%]" title={status}>{status}</span>}
      </div>

      {saveError && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-border bg-destructive/10 shrink-0">
          <Icon name="error" size={13} className="text-destructive shrink-0 mt-0.5" />
          <span className="text-xs text-destructive leading-relaxed">{saveError}</span>
        </div>
      )}

      {conflict && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-warning/10 shrink-0 flex-wrap">
          <Icon name="warning" size={13} className="text-warning shrink-0" />
          <span className="text-xs text-warning leading-relaxed flex-1 min-w-0">
            {t('codeEditor.conflict.diskChanged')}
          </span>
          <button
            onClick={() => void save(true)}
            className="shrink-0 px-2 py-1 rounded-md text-xs bg-warning/15 text-warning hover:bg-warning/25 transition-colors"
          >
            {t('codeEditor.conflict.overwrite')}
          </button>
          <button
            onClick={() => void reload()}
            className="shrink-0 px-2 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {t('codeEditor.conflict.reload')}
          </button>
        </div>
      )}

      {/* Monaco 编辑区：automaticLayout 跟随容器尺寸，无 minimap（侧栏窄） */}
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          language={language}
          value={content}
          theme="vs-dark"
          onMount={handleMount}
          onChange={handleChange}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            renderWhitespace: 'selection',
            fixedOverflowWidgets: true,
          }}
        />
      </div>

      {outputOpen && (
        <div className="shrink-0 border-t border-border bg-terminal-bg">
          <div className="flex items-center gap-2 px-3 py-1 border-b border-border">
            <span className="text-[11px] font-medium text-foreground-muted">{t('codeEditor.output')}</span>
            {running && <Spinner size="sm" className="text-foreground-muted" />}
            {!running && exitCode !== null && (
              <span className={`text-[11px] tabular-nums ${exitCode === 0 ? 'text-success' : 'text-destructive'}`}>
                {t('codeEditor.exitCode', { code: exitCode })}
              </span>
            )}
          </div>
          <pre
            ref={outputRef}
            className="max-h-40 overflow-auto px-3 py-2 text-[11px] leading-relaxed font-mono text-terminal-fg whitespace-pre-wrap break-all"
          >
            {output || (running ? t('codeEditor.running', { file: fileName }) : '')}
          </pre>
        </div>
      )}
    </div>
  )
}
