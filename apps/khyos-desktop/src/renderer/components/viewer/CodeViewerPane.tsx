// khy-canary: Khy-20261102-332-6BDQ3FQ6
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { Skeleton } from '../ui/Skeleton'
import { MarkdownPreview } from './MarkdownPreview'
import { SourceView } from './SourceView'
import { detectExtension, detectLanguage } from './highlight'
import { useCodeDisplaySettings } from '../message/useCodeDisplaySettings'

// 内置编辑器（Monaco，约 4MB）按需加载：查看态是绝大多数路径，
// 不进首包。monacoSetup 的本地 loader/worker 接线在 main.tsx 入口已完成。
const CodeEditorPane = lazy(() =>
  import('./CodeEditorPane').then((m) => ({ default: m.CodeEditorPane }))
)

// 代码查看面板（codeViewer.* 文案，ZC-ALIGN 逐项对齐）：
// - .md 文件：Markdown 分段控件「预览 | 源码」（markdownMode/markdownPreview/
//   markdownSource），预览走本目录的文档级 Markdown 渲染器（表格/链接一等公民）
// - 其他文本文件：直接源码视图
// - 四态：loadingFile / empty / fileMissing / fileTooLarge / binary
// - 自动换行开关（wrapLines）只作用于源码视图
// - 语法高亮与行号来自「设置 → 外观 → 代码高亮」（codeHighlight/codeLineNumbers）
//
// 数据经 preload __KHYOS__.codeViewerRead → main codeViewer:read（256KB 上限
// + 二进制检测都在主进程，渲染层只消费四态契约）。

interface ViewerPayload {
  ok: boolean
  state?: 'ok' | 'tooLarge' | 'binary' | 'missing' | 'empty'
  content?: string
  size?: number
  error?: string
}

interface CodeViewerPaneProps {
  filePath: string
  // 关闭按钮 → 由 AppLayout 移除标签（codeViewer.close = 关闭代码面板）
  onClose: () => void
  // 编辑态脏状态外抛 → AppLayout 给标签打脏点、关标签前弹确认
  onDirtyChange?: (dirty: boolean) => void
}

// 四态文案与图标：文案走 i18n（codeViewer.fileTooLarge / binary /
// fileMissing / empty），图标走共享的 Icon 注册表（不用字符字形）。
const STATE_VIEW: Record<string, { i18nKey: string; icon: IconName }> = {
  tooLarge: { i18nKey: 'codeViewer.fileTooLarge', icon: 'warning' },
  binary: { i18nKey: 'codeViewer.binary', icon: 'file' },
  missing: { i18nKey: 'codeViewer.fileMissing', icon: 'file' },
  empty: { i18nKey: 'codeViewer.empty', icon: 'doc' },
}

// 加载态的骨架：宽度按代码行的长短错落排布（纯布局，不是文案）
const SKELETON_ROW_WIDTHS = ['w-1/3', 'w-2/3', 'w-1/2', 'w-3/4', 'w-2/5', 'w-1/4']

export function CodeViewerPane({ filePath, onClose, onDirtyChange }: CodeViewerPaneProps) {
  const { t } = useTranslation()
  const [payload, setPayload] = useState<ViewerPayload | null>(null)
  const [loadError, setLoadError] = useState('')
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [wrapLines, setWrapLines] = useState(false)
  // 查看 / 编辑同标签切换：编辑态只对可读文本开放（ok 与 empty 两态），
  // tooLarge / binary / missing 保持只读 —— 那些态进了编辑器也改不了。
  const [editing, setEditing] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  // 行号 / 语法高亮两个开关与消息区共用同一份读取路径
  // （message/useCodeDisplaySettings.ts，读 settings.json 的 codeHighlight /
  // codeLineNumbers）。设置页写入后由设置区触发重读，这里只订阅。
  const codeDisplay = useCodeDisplaySettings()

  const fileName = useMemo(() => {
    const seg = filePath.split(/[\\/]/).pop() || filePath
    return seg
  }, [filePath])

  const isMarkdown = /\.md$/i.test(fileName)
  // Non-markdown files have no preview mode: source only
  const effectiveMode = isMarkdown ? mode : 'source'

  const language = useMemo(() => detectLanguage(fileName), [fileName])
  const extension = useMemo(() => detectExtension(fileName), [fileName])

  useEffect(() => {
    let cancelled = false
    setPayload(null)
    setLoadError('')
    const api = (window as unknown as {
      __KHYOS__?: { codeViewerRead?: (p: string) => Promise<ViewerPayload> }
    }).__KHYOS__
    if (!api?.codeViewerRead) {
      setLoadError('代码查看通道不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    api.codeViewerRead(filePath).then((res) => {
      if (!cancelled) setPayload(res)
    }).catch(() => {
      if (!cancelled) setLoadError('文件读取请求失败：主进程无响应，请重启应用后重试')
    })
    return () => { cancelled = true }
  }, [filePath])

  const busy = !payload && !loadError
  const stateView = payload && !payload.ok ? STATE_VIEW[payload.state || 'missing'] : null

  const canEdit = payload?.ok === true || payload?.state === 'empty'

  const backToView = () => {
    setEditing(false)
    setEditorDirty(false)
    onDirtyChange?.(false)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部：文件名 + 模式切换 + 自动换行 + 关闭（codeViewer.close） */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Icon name="code" size={14} className="text-foreground-muted shrink-0" />
        <span className="text-sm font-medium text-foreground truncate flex-1" title={filePath}>
          {fileName}
        </span>
        {extension && (
          <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-foreground-muted bg-surface">
            {extension}
          </span>
        )}
        {canEdit && (
          editing ? (
            <button
              onClick={backToView}
              disabled={editorDirty}
              className="shrink-0 px-2 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={editorDirty ? t('codeEditor.dirtyBlockView') : t('codeEditor.back')}
            >
              {t('codeEditor.back')}
            </button>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="shrink-0 px-2 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
              title={t('codeEditor.editTooltip')}
            >
              {t('codeEditor.edit')}
            </button>
          )
        )}
        {!editing && isMarkdown && payload?.ok && (
          <div
            className="flex items-center rounded-lg bg-surface border border-border p-0.5"
            role="group"
            aria-label={t('codeViewer.markdownMode')}
          >
            <button
              onClick={() => setMode('preview')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'preview'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
              aria-pressed={mode === 'preview'}
            >
              {t('codeViewer.markdownPreview')}
            </button>
            <button
              onClick={() => setMode('source')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'source'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
              aria-pressed={mode === 'source'}
            >
              {t('codeViewer.markdownSource')}
            </button>
          </div>
        )}
        {!editing && (
          <button
            onClick={() => setWrapLines(v => !v)}
            className={`px-2 py-1 rounded-md text-xs transition-colors ${
              wrapLines
                ? 'bg-brand-subtle text-brand'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
            }`}
            aria-pressed={wrapLines}
            title={t('codeViewer.wrapLines')}
          >
            {t('codeViewer.wrapLines')}
          </button>
        )}
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
          aria-label={t('codeViewer.close')}
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      {/* 编辑态：Monaco 独占内容区（自带工具栏/输出条/冲突横幅）。
          查看态的四态与源码/预览照旧。 */}
      {editing ? (
        <div className="flex-1 min-h-0">
          <Suspense
            fallback={
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-foreground-muted">
                <Spinner size="sm" className="text-foreground-muted" />
                <span>{t('codeEditor.loading', { file: fileName })}</span>
              </div>
            }
          >
            <CodeEditorPane filePath={filePath} onDirtyChange={setEditorDirty} />
          </Suspense>
        </div>
      ) : (
      <div className="flex-1 overflow-auto">
        {busy ? (
          // 动作 + 目标：字节进度拿不到 —— codeViewer:read 是一次性读取，没有
          // 进度事件，所以只报文件名，不编造 KB 数字。
          // 加载态不再是一句居中灰字：转圈 + 文件名给出「正在做什么」，下面的
          // 骨架先把版面摆出来，内容到位后原地替换，视线不跳。
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-foreground-muted">
              <Spinner size="sm" className="text-foreground-muted" />
              <span>{t('codeViewer.loadingFile')}</span>
              <span className="font-mono text-foreground-muted truncate">{fileName}</span>
            </div>
            <div className="mt-4 space-y-2">
              {SKELETON_ROW_WIDTHS.map((w, i) => (
                <Skeleton key={`sk-${i}`} className={`h-3 ${w}`} />
              ))}
            </div>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
            <Icon name="error" size={22} className="text-destructive" />
            <span className="text-sm text-destructive leading-relaxed">{loadError}</span>
          </div>
        ) : stateView ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
            <Icon name={stateView.icon} size={22} className="text-foreground-muted" />
            <span className="text-sm text-foreground-muted leading-relaxed max-w-xs">
              {t(stateView.i18nKey)}
            </span>
          </div>
        ) : (
          <>
            {effectiveMode === 'preview' ? (
              <div className="px-5 py-4">
                <MarkdownPreview content={payload?.content || ''} />
              </div>
            ) : (
              <SourceView
                content={payload?.content || ''}
                language={language}
                showLineNumbers={codeDisplay.lineNumbers}
                highlight={codeDisplay.highlight}
                wrap={wrapLines}
              />
            )}
          </>
        )}
      </div>
      )}
    </div>
  )
}
