// SceneDock — khyos 活场景的手动切换条。
//
// 为什么需要它：活场景默认自动轮播（周期 118s），但「我想现在看夜雨」不能靠等。
// 独立桌面页（delivery/brand/khyos-desktop）验证过同一套 chip 交互：点击与
// 数字键同路、当前场景高亮、闲置变暗。这里把它搬进应用，样式沿用品牌令牌
// （ink/paper/accent），不引第二套色。
//
// 轮播进度条是应用侧加的：自动切换每 20-40s 一次，没有进度感知的用户会觉得
// 场景「随机乱跳」——一条 2px 的线就让节奏可见，也知道下一场什么时候来。
import { useEffect, useRef, useState } from 'react'

export interface SceneDockProps {
  /** 场景 id 表（轮播顺序）。 */
  sceneIds: string[]
  /** id → 中文名。 */
  sceneTitle: (id: string) => string
  /** 当前场景 id。 */
  current: string
  /** 当前场景的轮播进度，0..1；到 1 即自动切下一场。 */
  progress: number
  onSelect: (id: string) => void
  onStep: (step: number) => void
  /** 关闭活背景（仅本次会话；刷新后按壁纸预设恢复）。 */
  onHide: () => void
}

// 多久不动就把 dock 淡下去：桌面主要是用来看的，常驻控件不该一直抢注意力。
const IDLE_MS = 4000

export function SceneDock({ sceneIds, sceneTitle, current, progress, onSelect, onStep, onHide }: SceneDockProps) {
  const [idle, setIdle] = useState(false)
  const timerRef = useRef(0)

  useEffect(() => {
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    wake()
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timerRef.current)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])

  const clamped = Math.min(1, Math.max(0, progress))

  return (
    <div
      className={`fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[rgba(20,17,14,0.55)] px-2.5 py-1.5 backdrop-blur-md transition-opacity duration-700 hover:opacity-100 ${
        idle ? 'opacity-40' : 'opacity-75'
      }`}
      role="toolbar"
      aria-label="khyos 场景切换"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="rounded-full border border-white/20 px-2 py-1 font-mono text-xs text-[rgba(246,242,236,0.72)] hover:border-white/50 hover:text-[#f6f2ec]"
        onClick={() => onStep(-1)}
        aria-label="上一个场景"
        title="上一个场景（←）"
      >
        ‹
      </button>
      {sceneIds.map((id, i) => (
        <button
          key={id}
          type="button"
          className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
            id === current
              ? 'border-[#e2703a] bg-[#e2703a] text-[#14110e]'
              : 'border-white/20 text-[rgba(246,242,236,0.72)] hover:border-white/50 hover:text-[#f6f2ec]'
          }`}
          aria-pressed={id === current}
          onClick={() => onSelect(id)}
          title={`${sceneTitle(id)}（${i + 1}）`}
        >
          {i + 1} {sceneTitle(id)}
        </button>
      ))}
      <button
        type="button"
        className="rounded-full border border-white/20 px-2 py-1 font-mono text-xs text-[rgba(246,242,236,0.72)] hover:border-white/50 hover:text-[#f6f2ec]"
        onClick={() => onStep(1)}
        aria-label="下一个场景"
        title="下一个场景（→）"
      >
        ›
      </button>
      <span className="pl-1 font-mono text-[11px] text-[rgba(246,242,236,0.4)]">← → / 1-4</span>
      <button
        type="button"
        className="ml-0.5 rounded-full border border-white/20 px-2 py-1 font-mono text-xs text-[rgba(246,242,236,0.5)] hover:border-white/50 hover:text-[#f6f2ec]"
        onClick={onHide}
        aria-label="关闭活背景"
        title="关闭活背景（本次会话；刷新后按壁纸预设恢复）"
      >
        ✕
      </button>
      {/* 轮播进度：贴着 pill 底边的一条 2px 线，走满即自动换场。
          手动切换后由父组件把 progress 复位，线和场景始终同拍。 */}
      <span className="pointer-events-none absolute bottom-0 left-3 right-3 h-0.5 overflow-hidden rounded-full bg-white/10">
        <span
          className="block h-full rounded-full bg-[#e2703a]/80 transition-[width] duration-200 ease-linear"
          style={{ width: `${(clamped * 100).toFixed(1)}%` }}
        />
      </span>
    </div>
  )
}
