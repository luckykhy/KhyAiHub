/**
 * usePacedPercent — 把 `pacedProgress` 的节拍接进 React：每 PACED_RENDER_MS 重绘一次，
 * 显示值一次只 +1%，向真实值靠拢且永不越过它。
 *
 * 契约（与 `@khy/ui-shared` 的 usePacedProgress / CLI 侧节拍器一致）：
 *   · 单调不减；真实值没到 100 就绝不出 100；
 *   · **真实值到 100 也不跳**：剩下的距离仍由同一套 1%/帧 的节拍走过去（收尾走快速档），
 *     以 `settleMs` 为总时限 —— 到点即落在真实值上。旧实现「真实值一到 100 就赋显示值 100」
 *     正是用户说的「卡在一个地方很久、然后突然加载完成」；
 *   · 追平真实值 / 收尾到期 / 组件卸载 / 不活跃 → 立刻停表，不留空转定时器；
 *   · `prefers-reduced-motion: reduce` → 不叠加节拍，直接报真实值。
 */
import { useEffect, useRef, useState } from 'react';
import {
  PACED_DEFAULTS,
  PACED_RENDER_MS,
  PACED_SETTLE_MS,
  advancePaced,
  clampPercent,
  prefersReducedMotion,
  type PacedState,
} from './pacedProgress';

export interface UsePacedPercentOptions {
  /** 是否正在等待；false → 只报真实值，不挂定时器。 */
  active?: boolean;
  /**
   * 收尾时限（毫秒）：真实值到 100 之后条还要 1% 1% 地走完剩下的距离，但最多走这么久。
   * 默认 `PACED_SETTLE_MS`。常见路径（条本来就在 90% 上下）几帧就走完了；只有「真实值从
   * 很低处一步跳到 100」才会到点 —— 那时直接落在真实值上，不把收尾拖成长等待。
   */
  settleMs?: number;
}

export function usePacedPercent(realPercent: number, options: UsePacedPercentOptions = {}): number {
  const { active = true, settleMs = PACED_SETTLE_MS } = options;
  const real = Math.floor(clampPercent(realPercent));
  // 工作是否已结束 —— 与「显示值已在 100」分开：结束也要 1% 1% 地走过去。
  const done = clampPercent(realPercent) >= 100;
  const staticMode = prefersReducedMotion();
  const [shown, setShown] = useState(() => real);
  const stateRef = useRef<PacedState>({ shown: real, lastStepAt: Date.now() });
  // 收尾时限（仅在 done 期间有意义）：0 = 未起算。
  const settleRef = useRef(0);

  useEffect(() => {
    if (!done) settleRef.current = 0;
    // 减少动效 / 不活跃 / 已经追平真实值：不挂表，直接落在真实值上。
    // （这一段是「没有东西可动」而非「跳」——条本来就贴在真实值上。）
    if (staticMode || !active || stateRef.current.shown >= real) {
      stateRef.current = { shown: real, lastStepAt: Date.now() };
      setShown(real);
      return undefined;
    }
    if (done && settleRef.current === 0) {
      settleRef.current = Date.now() + Math.max(0, Number(settleMs) || 0);
    }
    const id = setInterval(() => {
      const at = Date.now();
      const next = advancePaced(stateRef.current, real, at, PACED_DEFAULTS, { done });
      stateRef.current = next;
      setShown((prev) => (next.shown === prev ? prev : next.shown));
      // 追平真实值即停表 —— 看板/状态栏上几十个条各自停表，不留空转定时器。
      if (next.shown >= real) {
        clearInterval(id);
        return;
      }
      // 收尾到期：落在真实值上并停表。1% 1% 已经走了一段，这里只是不让它继续拖着。
      if (done && settleRef.current && at >= settleRef.current) {
        stateRef.current = { shown: real, lastStepAt: at };
        setShown(real);
        clearInterval(id);
      }
    }, PACED_RENDER_MS);
    return () => clearInterval(id);
  }, [real, active, staticMode, done, settleMs]);

  if (staticMode) return real;
  // 真实值回退时不许显示值悬在上面。
  return Math.min(shown, real);
}

export default usePacedPercent;