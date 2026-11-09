import { useState } from 'react'

// 撤销文件改动对话框（原同文件内的 CheckpointRewindDialog）。
//
// 2026-11-01：随「Token 用量（本月配额）」面板整体删除而拆出独立文件 ——
// 该文件原名 ContextUsage.tsx，删掉用量面板后只剩本组件，留在原文件里会让
// 「按文件名找上下文用量」的搜索落到一个没有用量逻辑的文件上（误导后来人）。
// 组件体逐字节保留，只改了 import（不再需要 Icon / useEffect / useCallback /
// useRef —— 本组件只用到 useState）。
export function CheckpointRewindDialog({ visible, onClose, onConfirm }: { visible: boolean; onClose: () => void; onConfirm: () => void }) {
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)

  const safeToUndo = 3
  const unsafeToUndo = 1
  const ignored = 1

  const handleCheck = () => {
    setChecking(true)
    setTimeout(() => {
      setChecking(false)
      setChecked(true)
    }, 1500)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-lg font-semibold text-popover-foreground">撤销文件改动</h3>
          <p className="text-sm text-foreground-muted mt-1">撤销前会重新检查当前文件内容</p>
        </div>

        {/* 内容 */}
        <div className="px-6 py-4">
          {!checked ? (
            <div className="text-center py-6">
              <p className="text-sm text-foreground-muted mb-4">
                点击下方按钮检查可撤销的文件
              </p>
              <button
                onClick={handleCheck}
                disabled={checking}
                className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {checking ? '正在检查可撤销文件…' : '检查可撤销文件'}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 安全区 */}
              <div className="p-3 bg-success/10 rounded-xl border border-success/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-success" />
                  <span className="text-sm font-medium text-success">可安全撤销</span>
                  <span className="text-xs text-foreground-muted ml-auto">{safeToUndo} 个文件</span>
                </div>
                <div className="text-xs text-foreground-muted">这些文件未被外部修改，可以安全撤销</div>
              </div>

              {/* 不安全区 */}
              <div className="p-3 bg-destructive/10 rounded-xl border border-destructive/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-destructive" />
                  <span className="text-sm font-medium text-destructive">不能安全撤销</span>
                  <span className="text-xs text-foreground-muted ml-auto">{unsafeToUndo} 个文件</span>
                </div>
                <div className="text-xs text-foreground-muted">文件已被外部修改，撤销可能丢失更改</div>
              </div>

              {/* 忽略区 */}
              <div className="p-3 bg-surface rounded-xl border border-card-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-foreground/30" />
                  <span className="text-sm font-medium text-foreground-muted">已忽略</span>
                  <span className="text-xs text-foreground-muted ml-auto">{ignored} 个文件</span>
                </div>
                <div className="text-xs text-foreground-muted">bash/shell 修改不参与撤销</div>
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-popover-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground-muted hover:text-foreground rounded-lg hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => { onConfirm(); onClose() }}
            disabled={!checked}
            className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium disabled:opacity-30 hover:opacity-90 transition-opacity"
          >
            撤销文件
          </button>
        </div>
      </div>
    </div>
  )
}
