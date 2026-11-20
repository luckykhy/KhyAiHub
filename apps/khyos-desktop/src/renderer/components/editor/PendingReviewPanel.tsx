import { useMemo, useState } from 'react'
import type { EditorPendingItem } from '../../../shared/editorContract'
import type { DiffRow } from '../../../shared/toolDiff'
import { splitDiffHunks } from '../../../shared/editorDiff'
import { Icon } from '../ui/Icon'
import { baseName } from './editorModels'

// AI 改动待审轨（DESIGN-ARCH-210 M3）。卡片里的行模型来自后端唯一生产者
// （cli/writeDiffRows），块边界由 kind==='gap' 切出 —— 与 host 拼接受子集时用的
// hunks 下标一一对应，界面上勾哪几块，落盘就是哪几块。
//
// 「接受」在缓冲区脏时禁用：diff 基于磁盘内容，人手里的未保存修改一旦参与，
// 拼出来的子集就不再是用户看着审的那份东西。

interface PendingReviewPanelProps {
  items: EditorPendingItem[]
  dirtyPaths: Set<string>
  onDecide: (id: string, decision: { accept: boolean; acceptedHunks?: number[] }) => void
}

function RowView({ row }: { row: DiffRow }) {
  if (row.kind === 'gap' || row.kind === 'meta') {
    return <div className="px-2 py-0.5 text-foreground-muted/70 select-none">{row.text}</div>
  }
  if (row.kind === 'more' || row.kind === 'stat') {
    return <div className="px-2 py-0.5 text-foreground-muted select-none">{row.text}</div>
  }
  const isAdd = row.kind === 'add'
  const isDel = row.kind === 'del'
  return (
    <div className={`flex ${isAdd ? 'bg-success/10' : isDel ? 'bg-destructive/10' : ''}`}>
      <span className="w-7 shrink-0 select-none text-center text-foreground-muted/60">
        {isAdd ? '+' : isDel ? '-' : ' '}
      </span>
      <span className={`whitespace-pre pr-2 ${isAdd ? 'text-foreground' : isDel ? 'text-foreground/80' : 'text-foreground-muted'}`}>
        {row.text || ' '}
      </span>
    </div>
  )
}

function PendingCard({
  item,
  dirty,
  onDecide,
}: {
  item: EditorPendingItem
  dirty: boolean
  onDecide: PendingReviewPanelProps['onDecide']
}) {
  const hunks = useMemo(() => splitDiffHunks(item.rows), [item.rows])
  const [selected, setSelected] = useState<Set<number>>(() => new Set(hunks.map((h) => h.index)))
  const [showDiff, setShowDiff] = useState(true)
  const [busy, setBusy] = useState(false)
  // 行集被截断时界面只看到前若干块，而 host 按完整 hunk 表拼子集 —— 勾选下标
  // 会与隐藏块的边界错位，等于静默丢掉用户没看见的改动。此档只给整体接受/拒绝。
  const hunksLocked = item.truncated

  const toggle = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const submit = (accept: boolean) => {
    setBusy(true)
    onDecide(
      item.id,
      accept
        ? hunksLocked
          ? { accept: true }
          : { accept: true, acceptedHunks: [...selected].sort((a, b) => a - b) }
        : { accept: false },
    )
  }

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border">
        <Icon name="code" size={12} className="text-foreground-muted shrink-0" />
        <span className="text-[11px] font-medium text-foreground truncate" title={item.filePath}>
          {baseName(item.filePath)}
        </span>
        <span className="text-[10px] text-foreground-subtle truncate">{item.reason}</span>
        <div className="flex-1" />
        {item.added > 0 && <span className="text-[10px] text-success">+{item.added}</span>}
        {item.removed > 0 && <span className="text-[10px] text-destructive">-{item.removed}</span>}
      </div>

      {dirty && (
        <div className="flex items-start gap-1.5 px-2.5 py-1.5 bg-warning/10 border-b border-border">
          <Icon name="warning" size={12} className="text-warning shrink-0 mt-0.5" />
          <span className="text-[10px] leading-relaxed text-warning">
            该文件的缓冲区有未保存内容：diff 基于磁盘内容，请先保存或还原，再接受 AI 改动
          </span>
        </div>
      )}

      <div className="px-2.5 py-1.5 flex items-center gap-2">
        <button
          onClick={() => setShowDiff((v) => !v)}
          className="text-[10px] text-foreground-muted hover:text-foreground transition-colors"
        >
          {showDiff ? '收起 diff' : `查看 diff（${hunks.length} 块）`}
        </button>
        <div className="flex-1" />
        <span className="text-[10px] text-foreground-subtle">
          {hunksLocked ? '改动过长：只能整体接受或拒绝' : `已选 ${selected.size}/${hunks.length} 块`}
        </span>
      </div>

      {showDiff && (
        <div className="max-h-64 overflow-auto border-y border-border bg-surface/30 font-mono text-[11px] leading-5">
          {hunks.map((hunk) => (
            <div key={hunk.index} className="border-b border-border/60 last:border-b-0">
              <label className="flex items-center gap-1.5 px-2 py-0.5 bg-surface/60 cursor-pointer select-none">
                {!hunksLocked && (
                  <input
                    type="checkbox"
                    checked={selected.has(hunk.index)}
                    onChange={() => toggle(hunk.index)}
                    aria-label={`接受改动块 ${hunk.index + 1}`}
                    className="accent-brand"
                  />
                )}
                <span className="text-[10px] text-foreground-muted">改动块 {hunk.index + 1}</span>
              </label>
              {hunk.rows.map((row, i) => (
                <RowView key={i} row={row} />
              ))}
            </div>
          ))}
          {item.truncated && (
            <div className="px-2 py-1 text-[10px] text-warning">改动过长：卡片只显示前一部分，接受按完整内容写盘</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-2.5 py-1.5">
        <button
          onClick={() => submit(false)}
          disabled={busy}
          className="px-2 h-6 rounded-md text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors"
        >
          拒绝
        </button>
        <button
          onClick={() => submit(true)}
          disabled={busy || dirty || selected.size === 0}
          title={dirty ? '先保存或还原缓冲区内容，再接受 AI 改动' : undefined}
          className="px-2 h-6 rounded-md text-[11px] bg-brand/90 text-white hover:bg-brand disabled:opacity-40 transition-colors"
        >
          {selected.size === hunks.length ? '全部接受' : '接受选中块'}
        </button>
      </div>
    </div>
  )
}

export function PendingReviewPanel({ items, dirtyPaths, onDecide }: PendingReviewPanelProps) {
  if (!items.length) return null
  return (
    <aside className="w-[360px] shrink-0 border-l border-border flex flex-col min-h-0 bg-surface/20">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <Icon name="warning" size={13} className="text-warning shrink-0" />
        <span className="text-xs font-medium text-foreground">AI 改动待审（{items.length}）</span>
        <div className="flex-1" />
        <span className="text-[10px] text-foreground-subtle">未批准不落盘</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
        {items.map((item) => (
          <PendingCard key={item.id} item={item} dirty={dirtyPaths.has(item.filePath)} onDecide={onDecide} />
        ))}
      </div>
    </aside>
  )
}
