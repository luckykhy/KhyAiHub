// KhyosBackground — khyos 3D 活场景：以自包含成品页托管进应用的桌面背景。
//
// 为什么是 webview 而不是把 three.js 接进渲染层：本仓的 3D 约定是手写 WebGL，
// 而且它被 tests/khyPetModel.contract.test.cjs 的 M1 **强制执行**
// （package.json 里不得出现 three）。3D 世界因此以成品资产的形式进来——
// 独立桌面页（delivery/brand/khyos-desktop）构建出的单文件
// khyos-desktop.html，由 <webview> 托管（BrowserPane 已建立的模式：
// webviewTag + guest 进程）。应用自己的渲染层依旧 three-free，契约不动，
// M1 测试全绿。
//
// 交互分工：webview 只画画（pointer-events:none，不抢应用的点击）；切换条是
// 应用原生的 SceneDock，槽位表与页面同源（assets/khyos/scenes.json），
// 切换通过 executeJavaScript 送进页面。页面在 bg 模式关掉自己的轮播
// （?auto=0）——两个调度器必打架，只留应用这一个。
import { useCallback, useEffect, useRef, useState } from 'react'
import bgUrl from '../../assets/khyos/khyos-desktop.html?url'
import scenesData from '../../assets/khyos/scenes.json'
import { LIVE_OVERLAY_DARK, LIVE_OVERLAY_LIGHT } from '../../theme/background'
import { SceneDock } from './SceneDock'

interface SceneEntry {
  id: string
  name: string
  durationSec: number
}

// React 19 的类型已内置 <webview>（JSX.IntrinsicElements 里的 WebViewHTMLAttributes），
// **不要**再写 declare module 'react' 增强——那会和内置声明冲突（TS2717）。
// 但 @types/react 的 HTMLWebViewElement 是个空壳（extends HTMLElement），
// Electron 的 executeJavaScript 不在类型里；本地接口补上要用的那一个。
interface KhyosWebviewElement extends HTMLWebViewElement {
  executeJavaScript?: (code: string) => Promise<unknown>
}

const SCENES = (scenesData.scenes as SceneEntry[]).filter((s) => s && typeof s.id === 'string')
const DEFAULT_SLOT_SEC = 12

function slotSec(id: string): number {
  const entry = SCENES.find((s) => s.id === id)
  const declared = Number(entry?.durationSec)
  return declared > 0 ? declared : DEFAULT_SLOT_SEC
}

// dev 下 ?url 给的是 dev-server 路径，打包后是相对 bundle 的路径——两种都要
// 能拼上查询参数（页面靠 ?mode=bg&auto=0 切托管模式）。先解析成绝对 URL。
function bgSrc(): string {
  try {
    const url = new URL(bgUrl, document.baseURI)
    url.searchParams.set('mode', 'bg')
    url.searchParams.set('auto', '0')
    return url.toString()
  } catch {
    return bgUrl
  }
}

const BG_SRC = bgSrc()

function liveFlag(): string {
  return document.documentElement.style.getPropertyValue('--khy-bg-live').trim()
}

export function KhyosBackground() {
  const webviewRef = useRef<KhyosWebviewElement | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => liveFlag() === 'khyos-scene')
  const [current, setCurrent] = useState(() => SCENES[0]?.id ?? '')
  // 当前场景的轮播进度 0..1，喂给 dock 底部那条 2px 的线。
  const [progress, setProgress] = useState(0)
  // guest 的挂载尺寸：null = 还没量到。webview 等第一次测量出来才创建——
  // 元素在错误尺寸下创建过一次，guest 就按那个尺寸加载完，之后追不回来。
  const [guestSize, setGuestSize] = useState<{ w: number; h: number } | null>(null)

  // 量 wrapper 的真实尺寸。变化超过 48px 才更新 key（重挂 guest）：窗口拖拽
  // 过程中每几个像素重挂一次会把 guest 打爆，而桌面背景不需要那么精确。
  useEffect(() => {
    if (!active) return
    const wrap = wrapRef.current
    if (!wrap) return
    const measure = () => {
      const w = Math.round(wrap.clientWidth)
      const h = Math.round(wrap.clientHeight)
      if (w <= 0 || h <= 0) return
      setGuestSize((prev) => {
        if (!prev) return { w, h }
        return Math.abs(prev.w - w) > 48 || Math.abs(prev.h - h) > 48 ? { w, h } : prev
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [active])

  const sendScene = (id: string) => {
    const wv = webviewRef.current
    if (!wv || !id) return
    // setScene 在页面上是纯调度入口（纸色淡切）；guest 没就绪时静默失败，
    // dom-ready 后会补发。
    void wv.executeJavaScript?.(`window.__khyos && window.__khyos.setScene(${JSON.stringify(id)})`).catch(() => {})
  }
  // 壁纸预设切换 → 活背景起停。变量由 applyPreset 写在 <html> 的 style 上，
  // 与既有壁纸体系同一条契约，不新造状态通道。
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setActive(liveFlag() === 'khyos-scene'))
    observer.observe(root, { attributes: true, attributeFilter: ['style'] })
    return () => observer.disconnect()
  }, [])

  // guest 就绪后补发当前场景：webview 重载（key 变化 / crash 恢复）后页面
  // 回到自己的首场，不补发就和 dock 的高亮脱节。
  // 监听挂在 ref 回调里而不是 effect：dom-ready 可能在 commit 与 effect 之间
  // 触发（webview 元素一入 DOM 就开始加载），effect 挂晚了就永远等不到。
  const attachWebview = useCallback(
    (el: KhyosWebviewElement | null) => {
      webviewRef.current = el
      if (!el) return
      const onReady = () => {
        // 补发当前场景：webview 重载后页面回到自己的首场，不补发就和 dock 脱节。
        sendScene(current)
      }
      el.addEventListener('dom-ready', onReady)
      return () => el.removeEventListener('dom-ready', onReady)
    },
    // sendScene/current 每次渲染都是新闭包，这里只依赖 current——场景变了顶多
    // 重挂一次监听器，dom-ready 一生只发一次，重复监听没有意义。
    [current],
  )

  // 槽位调度：与页面 scenes.json 同一份时长，应用侧单一时序源。
  // 每次 current 变化效应重入，槽位起点随之重置——手动切换也重计轮播。
  // 同一个 interval 顺便推 dock 的轮播进度条：250ms 粒度对一条 2px 的线足够，
  // 不值得为它再开一个定时器。
  useEffect(() => {
    if (!active || !current) return
    const startedAt = performance.now()
    const durationMs = slotSec(current) * 1000
    setProgress(0)
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt
      setProgress(Math.min(1, elapsed / durationMs))
      if (elapsed < durationMs) return
      const idx = Math.max(0, SCENES.findIndex((s) => s.id === current))
      const next = SCENES[(idx + 1) % SCENES.length]
      if (!next) return
      setCurrent(next.id)
      sendScene(next.id)
    }, 250)
    return () => window.clearInterval(timer)
  }, [active, current])

  if (!active || SCENES.length === 0) return null

  const light = document.documentElement.classList.contains('theme-zai-light')

  return (
    <>
      {/* sticky 而不是 absolute：main 是滚动容器，absolute 会让背景层随内容
          变高；sticky top-0 钉在视口顶部，内容从上面滚过去。
          高度用内联样式而不是 Tailwind 的 h-screen：样式表是异步加载的，
          CSS 还没到的前几帧 wrapper 没有高度，webview 会按默认内在尺寸
          （约 150px）创建 guest——guest 按那个尺寸加载完之后，Electron 的
          自动跟随追不上元素后来的长大，场景就永远是一条带。 */}
      <div
        className="sticky top-0 z-0 w-full shrink-0 overflow-hidden"
        style={{ height: '100vh' }}
        ref={wrapRef}
      >
        {/* guest 只画画：pointer-events:none，点击全部留给应用。
            崩溃时 webview 留一块空白——纱罩与 dock 照常，应用不受影响。
            尺寸量到之前不挂载：按错误尺寸创建过的 guest 追不回来。 */}
        {guestSize && (
          <webview
            key={`${guestSize.w}x${guestSize.h}`}
            ref={attachWebview}
            src={BG_SRC}
            className="pointer-events-none"
            // 绝对定位 + inset-0 是 webview guest 正确尺寸的前提：流内块级元素
            // 会让 guest 停在默认 300x150（实测宽 1042 高 150，之后任何尺寸
            // 变化都不传播）。BrowserPane 用的是同一个 pattern。全部内联——
            // 样式表异步加载，类还没生效的前几帧元素会退回流内布局。
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
            aria-hidden="true"
          />
        )}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: light ? LIVE_OVERLAY_LIGHT : LIVE_OVERLAY_DARK }}
          aria-hidden="true"
        />
      </div>
      {/* dock 无条件渲染：guest 就绪只影响「补发当前场景」，不影响可见性——
          就绪门禁曾经把整条切换条吞掉（dom-ready 竞态），用户因此看不到按钮。 */}
      <SceneDock
        sceneIds={SCENES.map((s) => s.id)}
        sceneTitle={(id) => SCENES.find((s) => s.id === id)?.name ?? id}
        current={current}
        progress={progress}
        onSelect={(id) => {
          setCurrent(id)
          sendScene(id)
        }}
        onStep={(step) => {
            const idx = Math.max(0, SCENES.findIndex((s) => s.id === current))
            const next = SCENES[(idx + step + SCENES.length) % SCENES.length]
            if (!next) return
            setCurrent(next.id)
            sendScene(next.id)
          }}
          onHide={() => setActive(false)}
        />
    </>
  )
}
