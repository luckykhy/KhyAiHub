/**
 * progress 子模块入口 —— 渐进节拍（「宁可慢一些，1% 1% 地加载」）的对外面。
 */
export {
  STEP_MS,
  EASE_AFTER,
  SLOW_STEP_MS,
  CAP,
  RENDER_MS,
  DEFAULTS,
  normalizeOptions,
  pacedPercent,
  filledCells,
  renderBar,
  createPacer,
  prefersReducedMotion,
} from './pacedProgress.js';
export { usePacedProgress } from './usePacedProgress.js';