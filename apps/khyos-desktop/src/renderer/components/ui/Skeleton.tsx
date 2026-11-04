// khy-canary: Khy-20261102-325-4V24DKNZ
// 骨架屏 —— 全仓第一个骨架组件。
//
// 之前加载态只有两套：一句灰字（"加载中…"）或整页空态闪烁。两者都读作
// 「没内容」，而不是「正在来」。骨架把版面先摆出来，内容到位后原地替换，
// 用户的视线不会跳。
//
// 用 Tailwind 内建的 animate-pulse 而非自写 shimmer：全局的
// prefers-reduced-motion 降级（theme/globals.css）会自动把它压成静止灰块，
// 不用在这里再判一次偏好。

interface SkeletonProps {
  className?: string
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse rounded-md bg-foreground/10 ${className}`} aria-hidden="true" />
}

/** 文本段：若干行灰条，最后一行短一截（真实段落的收尾通常是半行）。 */
export function SkeletonLines({ lines = 3, className = '' }: SkeletonProps & { lines?: number }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={`skeleton-line-${i}`} className={i === lines - 1 ? 'w-2/3' : 'w-full'} />
      ))}
    </div>
  )
}

/**
 * 消息泡骨架：头部行（提示符位 + 名称 + 时间）+ 三行正文。
 * 尺寸对齐 MessageBubble 的真实结构（px-5 / 头部 gap-3 mb-3 / 正文 pl-10），
 * 真实消息到位时版面不跳。
 */
export function SkeletonBubble({ className = '' }: SkeletonProps) {
  return (
    <div className={`px-5 py-4 ${className}`}>
      <div className="flex items-center gap-3 mb-3">
        <Skeleton className="h-3.5 w-3.5 rounded-sm" />
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="pl-10">
        <SkeletonLines lines={3} />
      </div>
    </div>
  )
}
