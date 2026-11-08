// khy-canary: Khy-20261102-295-19R4SMNY
import { useState } from 'react'
import { Icon } from '../ui/Icon'
import { MAX_DIFF_ROWS, type DiffRow, type ToolDiff } from '../../../shared/toolDiff'

export interface ChangedFile {
  path: string
  status: string
  additions: number
  deletions: number
  /** host 从后端 `_khyWriteDiff` 产出的红绿行；拿不到时为 undefined（只显示文件名）。 */
  diff?: ToolDiff
}

const COLLAPSED_ROWS = 60

const STATUS_DOT: Record<string, string> = {
  added: 'bg-success',
  deleted: 'bg-destructive',
  modified: 'bg-warning',
}

function DiffRowView({ row, dual }: { row: DiffRow; dual: boolean }) {
  if (row.kind === 'gap' || row.kind === 'meta') {
    return <div data-kind={row.kind} className="px-3 py-0.5 text-foreground-muted/70 select-none">{row.text}</div>
  }
  if (row.kind === 'more') {
    return <div data-kind={row.kind} className="px-3 py-0.5 text-brand">{row.text}</div>
  }
  if (row.kind === 'stat') {
    return (
      <div data-kind={row.kind} className="mt-1 border-t border-card-border/60 px-3 py-1 text-foreground-muted select-none">
        {row.text}
      </div>
    )
  }

  const isAdd = row.kind === 'add'
  const isDel = row.kind === 'del'
  // 双列 gutter：旧号列只给 del/ctx，新号列只给 add/ctx；单列时每行用自己那份文件的号
  // （add=新号、del=旧号），与终端端的行号口径一致。
  const oldNum = isAdd ? '' : row.num ?? ''
  const newNum = isAdd ? row.numNew ?? row.num ?? '' : row.kind === 'ctx' ? row.numNew ?? '' : ''
  return (
    <div data-kind={row.kind} className={`flex ${isAdd ? 'bg-success/10' : isDel ? 'bg-destructive/10' : ''}`}>
      {dual ? (
        <>
          <span className="w-10 shrink-0 select-none px-2 text-right text-foreground-muted">{oldNum}</span>
          <span className="w-10 shrink-0 select-none px-2 text-right text-foreground-muted">{newNum}</span>
        </>
      ) : (
        <span className="w-10 shrink-0 select-none px-2 text-right text-foreground-muted">{row.num ?? ''}</span>
      )}
      <span
        className={`w-5 shrink-0 select-none text-center ${
          isAdd ? 'text-success' : isDel ? 'text-destructive' : 'text-foreground-muted/50'
        }`}
      >
        {isAdd ? '+' : isDel ? '-' : ' '}
      </span>
      <span
        className={`whitespace-pre pr-3 ${
          isAdd ? 'text-foreground' : isDel ? 'text-foreground/80' : 'text-foreground-muted'
        }`}
      >
        {row.text || ' '}
      </span>
    </div>
  )
}

export function DiffViewer({
  diff,
  embedded = false,
  defaultExpanded = true,
}: {
  diff: ToolDiff
  /** 嵌在别的卡片里（工具卡 / 汇总面板）时去掉外框，避免卡片套卡片。 */
  embedded?: boolean
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [showAll, setShowAll] = useState(false)
  const dual = diff.rows.some((row) => typeof row.numNew === 'number')
  const shown = showAll ? diff.rows : diff.rows.slice(0, COLLAPSED_ROWS)
  const hidden = diff.rows.length - shown.length

  return (
    <div className={embedded ? 'overflow-hidden rounded-lg border border-card-border' : 'khy-content-col my-3 overflow-hidden rounded-xl border border-card-border bg-card'}>
      <div className="flex items-center gap-2 border-b border-card-border bg-surface px-3 py-1.5">
        <Icon name="code" size={12} />
        <span className="flex-1 truncate text-xs text-foreground" title={diff.filePath}>
          {diff.filePath || '改动'}
        </span>
        {diff.added > 0 && <span className="text-xs font-medium text-success">+{diff.added}</span>}
        {diff.removed > 0 && <span className="text-xs font-medium text-destructive">-{diff.removed}</span>}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-surface-hover hover:text-foreground"
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      {expanded && (
        <div className="overflow-x-auto bg-card">
          <div className="min-w-max py-1 font-mono text-xs leading-5">
            {shown.map((row, i) => (
              <DiffRowView key={i} row={row} dual={dual} />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mt-1 px-3 py-0.5 text-brand hover:underline"
              >
                还有 {hidden} 行未显示，点击展开
              </button>
            )}
            {diff.truncated && (
              <div className="px-3 py-0.5 text-warning">
                改动过大，仅传输前 {MAX_DIFF_ROWS} 行（其余未显示）
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function DiffSummary({
  files,
  onViewDiff,
  onUndo,
}: {
  files: ChangedFile[]
  onViewDiff?: (path: string) => void
  onUndo?: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  return (
    <div className="khy-content-col my-3 khy-tui overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex items-center gap-2 border-b border-card-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex flex-1 items-center gap-2 text-sm text-foreground/70 transition-colors hover:text-foreground"
        >
          <span className={`text-xs transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>
            <Icon name="chevron-right" size={12} />
          </span>
          <span className="font-medium">本轮文件改动</span>
          <span className="text-xs text-foreground-muted">{files.length} 个文件</span>
          {totalAdditions > 0 && <span className="text-xs text-success">+{totalAdditions}</span>}
          {totalDeletions > 0 && <span className="text-xs text-destructive">-{totalDeletions}</span>}
        </button>
        {onUndo && (
          <button
            type="button"
            onClick={onUndo}
            className="rounded-md border border-card-border px-3 py-1 text-xs text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            撤销文件改动
          </button>
        )}
      </div>

      {expanded && (
        <div className="py-1">
          {files.map((file) => {
            const open = openPath === file.path
            return (
              <div key={file.path}>
                <div className="flex items-center gap-2 px-4 py-2 transition-colors hover:bg-surface-hover">
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT[file.status] || 'bg-warning'}`} />
                  <button
                    type="button"
                    disabled={!file.diff}
                    onClick={() => setOpenPath(open ? null : file.path)}
                    className={`flex-1 truncate text-left text-sm ${
                      file.diff ? 'text-foreground hover:underline' : 'cursor-default text-foreground'
                    }`}
                    title={file.diff ? '展开这次改动的红绿行' : '这次改动没有可显示的 diff'}
                  >
                    {file.path}
                  </button>
                  {file.additions > 0 && <span className="text-xs text-success">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-xs text-destructive">-{file.deletions}</span>}
                  {file.diff && (
                    <button
                      type="button"
                      onClick={() => setOpenPath(open ? null : file.path)}
                      className="ml-2 text-xs text-brand hover:underline"
                    >
                      {open ? '收起改动' : '查看改动'}
                    </button>
                  )}
                  {onViewDiff && (
                    <button
                      type="button"
                      onClick={() => onViewDiff(file.path)}
                      className="text-xs text-foreground-muted hover:text-foreground hover:underline"
                    >
                      打开文件
                    </button>
                  )}
                </div>
                {open && file.diff && (
                  <div className="px-4 pb-3 pt-1">
                    <DiffViewer diff={file.diff} embedded defaultExpanded />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
