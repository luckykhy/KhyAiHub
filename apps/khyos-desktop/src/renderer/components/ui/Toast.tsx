// khy-canary: Khy-20261102-327-MM3WCF1V
import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

interface ToastProps {
  message: string
  type?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
  onClose?: () => void
}

type ToastType = NonNullable<ToastProps['type']>

// 图标取自 Icon 注册表（统一 1.6 描边）：此前是 Unicode 字符（信息圈 / 对勾 /
// 告警三角 / 叉），12–14px 下字重与基线都和相邻的线形图标对不齐。
// 语义色：信息中性、成功/告警/错误各走对应令牌。
const TYPE_CONFIG: Record<ToastType, { bg: string; border: string; icon: IconName; iconClass: string }> = {
  info: { bg: 'bg-toast', border: 'border-border', icon: 'info', iconClass: 'text-foreground-muted' },
  success: { bg: 'bg-success/10', border: 'border-success/30', icon: 'check', iconClass: 'text-success' },
  warning: { bg: 'bg-warning/10', border: 'border-warning/30', icon: 'warning', iconClass: 'text-warning' },
  error: { bg: 'bg-destructive/10', border: 'border-destructive/30', icon: 'error', iconClass: 'text-destructive' },
}

// 展示型 toast 单件。容器（列表）在 ToastContainer.tsx 里 —— 那里是 redux 接线版，
// 本文件只管单件的呈现，两处不再各有一个同名实现。
export function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  const [visible, setVisible] = useState(true)

  // onClose 每次父级渲染都是新函数（列表里写的是内联箭头）。若把它放进倒计时的
  // 依赖里，**父级每重渲染一次，这枚 toast 的剩余时间就被重置回满格** —— 新 toast
  // 入栈或 redux 任意更新都会让在飞的几枚一起重新计时，表现为「toast 赖着不走」。
  // 用 ref 兜住回调，倒计时只认 duration。
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // 退场定时器（可见性翻假后 200ms 才真正移除）单独持有，卸载时清掉，
  // 避免组件已经卸载还去派发 removeToast。
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      exitTimer.current = setTimeout(() => onCloseRef.current?.(), 200)
    }, duration)
    return () => {
      clearTimeout(timer)
      if (exitTimer.current) clearTimeout(exitTimer.current)
    }
  }, [duration])

  const config = TYPE_CONFIG[type]

  return (
    // 入场 animate-slide-up / 退场 transition-[opacity,translate]：按全局动效口径
    // （globals.css「动效」段）只动位移与透明度，不动 width/height/top/left；
    // 注意 Tailwind 4 的 translate-y-* 走的是 CSS `translate` 属性（不是 transform），
    // 所以过渡属性要写 translate，写成 transform 会让退场位移「瞬移」。
    // prefers-reduced-motion 下由全局降级块压成静止（入场瞬间到位）。
    <div
      className={`flex items-start gap-2.5 px-4 py-2.5 rounded-lg border shadow-overlay max-w-[min(26rem,calc(100vw_-_2rem))] ${config.bg} ${config.border} transition-[opacity,translate] duration-200 ease-out animate-slide-up ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${config.iconClass}`}>
        <Icon name={config.icon} size={14} />
      </span>
      <span className="text-sm text-foreground break-words min-w-0">{message}</span>
    </div>
  )
}
