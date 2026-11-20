/**
 * useResponsive 契约测试（FE-01）。
 *
 * 此前同名 .js 与 .ts 两份实现并存，Vite 默认扩展名优先级让**产线**解析到 .js
 * （只返回 {isMobile, isDesktop, windowWidth}），而消费方要的是 .ts 的
 * getMobileConfig / isTablet / isPortrait / viewportMode —— K 线路径在
 * `getMobileConfig()` 上直接抛 TypeError。
 *
 * 本测试用**无扩展名**导入（与产线解析同一条路径），并断言消费方依赖的字段齐全：
 *   - SimpleTradingInterface.js:297 → { isMobile, getMobileConfig }
 *   - Profile.vue:494              → { isMobile, isTablet, isPortrait }
 *   - Trading.vue:867               → 七个字段全用
 */
import { describe, it, expect } from 'vitest'
import { useResponsive } from '@/composables/useResponsive'

describe('useResponsive 契约', () => {
  it('返回消费方依赖的全部字段（含 getMobileConfig）', () => {
    const r = useResponsive()
    const required = [
      'isMobile',
      'isTablet',
      'isDesktop',
      'isPortrait',
      'isLandscape',
      'viewportMode',
      'getMobileConfig',
    ]
    for (const key of required) {
      expect(r).toHaveProperty(key)
    }
  })

  it('getMobileConfig() 返回配置对象，maxKlineCount 是数字', () => {
    // K 线渲染路径（SimpleTradingInterface.js:299 → :2116）此前在这里抛
    // TypeError: getMobileConfig is not a function
    const r = useResponsive()
    const config = r.getMobileConfig()
    expect(config).toBeTruthy()
    expect(typeof config.maxKlineCount).toBe('number')
  })

  it('viewportMode 是 mobile/tablet/desktop 之一', () => {
    const r = useResponsive()
    expect(['mobile', 'tablet', 'desktop']).toContain(r.viewportMode.value ?? r.viewportMode)
  })
})
