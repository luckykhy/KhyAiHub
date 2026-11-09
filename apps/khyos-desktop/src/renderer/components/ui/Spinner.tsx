// khy-canary: Khy-20261102-326-989MKJBM
interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /**
   * 单独出现（旁边没有说明文字）时给出可读标签；留空则视为装饰件 ——
   * 屏幕阅读器直接跳过，不念「图片 / 图像」。
   */
  label?: string
}

export function Spinner({ size = 'md', className = '', label }: SpinnerProps) {
  const sizeMap = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' }
  return (
    <svg
      className={`animate-spin ${sizeMap[size]} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
