// khy-canary: Khy-20261108-358-T7K2QW9D
import { useEffect, useState } from 'react'

/**
 * useTicker — 只有 `active` 为真时才走的「现在」心跳。
 *
 * 用途是纯 UI 计时（等待秒数、工具运行时长），不是任务截止：停下即卸载定时器，
 * 从不 kill 任何任务（规则 3）。间隔默认 500ms，让 0.1s 档的耗时读数不至于僵住。
 */
export function useTicker(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [active, intervalMs])

  return now
}

export default useTicker
