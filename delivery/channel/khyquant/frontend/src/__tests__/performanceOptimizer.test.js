/**
 * performanceOptimizer.test.js — locks the throttle/debounce/hw-accel contract
 * in src/utils/performanceOptimizer. `throttleData` truncates a K-line array to
 * its newest `maxCount` entries (the shape the trading page consumes);
 * debounce is inactivity-based and must preserve `this` and forward the final args.
 *
 * 导入**不带扩展名**：与产线（Vite）解析同一条路径。此前这里写死 '.js'，
 * 锁的是一份同名影子实现（那份的 throttleData 是函数节流，与产线语义不同），
 * 而 Vite 实际解析到的恰恰是它 —— 测试与产线跑的不是同一份代码（FE-01）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { throttleData, debounce, enableHardwareAcceleration } from '../utils/performanceOptimizer'

describe('performanceOptimizer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('throttleData keeps only the newest maxCount entries', () => {
    expect(throttleData([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5])
  })

  it('throttleData returns the input unchanged when it is already short enough', () => {
    expect(throttleData([1, 2], 5)).toEqual([1, 2])
  })

  it('debounce delays the call until inactivity and forwards the last args + this', () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 100)
    debounced('x')
    debounced('y')
    debounced('z')
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(99)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('z')
  })

  it('debounce preserves the caller `this`', () => {
    let seenThis = null
    const fn = function () {
      seenThis = this
    }
    const ctx = { marker: true }
    const debounced = debounce(fn, 10)
    debounced.call(ctx, 'v')
    vi.advanceTimersByTime(10)
    expect(seenThis).toBe(ctx)
  })

  it('enableHardwareAcceleration sets the transform-gpu layer styles and no-ops on falsy el', () => {
    const el = document.createElement('div')
    enableHardwareAcceleration(el)
    expect(el.style.transform).toBe('translateZ(0)')
    expect(el.style.backfaceVisibility).toBe('hidden')
    expect(el.style.willChange).toBe('transform')
    // falsy element is a safe no-op
    expect(() => enableHardwareAcceleration(null)).not.toThrow()
  })
})
