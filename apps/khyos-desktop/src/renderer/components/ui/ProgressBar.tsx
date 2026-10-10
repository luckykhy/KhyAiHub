import { usePacedPercent } from './usePacedPercent'

interface ProgressBarProps {
  value: number
  max?: number
  label?: string
  showPercentage?: boolean
  size?: 'sm' | 'md'
  className?: string
  /** 关闭渐进节拍（默认开）。只有「值即既成事实、没有在跑的操作」时才该关。 */
  pace?: boolean
  /** 这段进度是否仍在推进；false → 只报真实值，不挂定时器。 */
  active?: boolean
}

/**
 * 通用进度条 —— **填充**按 1% 的步长向 `value/max` 靠拢（「宁可慢一些，1% 1% 地加载」），
 * 而 `showPercentage` 那行数字仍是真实值：数不作假，条不冻结。
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  showPercentage = false,
  size = 'md',
  className = '',
  pace = true,
  active = true,
}: ProgressBarProps) {
  const realPercentage = Math.min(100, Math.max(0, (value / max) * 100))
  const real = Math.round(realPercentage)
  // 钩子必须无条件调用（Hooks 规则），`pace` 关时再用真实值覆盖。
  const paced = usePacedPercent(realPercentage, { active })
  const percentage = pace ? paced : real
  const heightClass = size === 'sm' ? 'h-1' : 'h-2'

  return (
    <div className={`w-full ${className}`}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between mb-1">
          {label && <span className="text-xs text-foreground/60">{label}</span>}
          {showPercentage && <span className="text-xs text-foreground/40 tabular-nums">{real}%</span>}
        </div>
      )}
      <div className={`w-full bg-foreground/10 rounded-full overflow-hidden ${heightClass}`}>
        <div
          className="h-full bg-brand rounded-full transition-[width] duration-150 ease-linear"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}

export function ContextUsageBar({ used, total }: { used: number; total: number }) {
  const percentage = (used / total) * 100
  const color = percentage > 90 ? 'bg-destructive' : percentage > 70 ? 'bg-warning' : 'bg-brand'

  return (
    <div className="flex items-center gap-2">
      {/*
        这是**上下文用量表**（已用/窗口），不是「一段等待的进度」：值来自当前会话的事实，
        没有在跑的操作可等。所以刻意**不加**渐进节拍 —— 把 72% 的用量从 0% 爬到 72% 会让
        用户在这一段时间里读到自己只用了很少，那是误报。
      */}
      <div className="flex-1 h-1.5 bg-foreground/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs text-foreground/40 tabular-nums">
        {(used / 1000).toFixed(1)}K / {(total / 1000).toFixed(0)}K
      </span>
    </div>
  )
}