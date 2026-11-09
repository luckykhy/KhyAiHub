// khy-canary: Khy-20261102-303-AZTX4PBT
// 代码展示设置（设置 → 外观 → 代码高亮 / 行号显示）。
//
// 这两个开关在设置页写入 settings.json（AppearanceSettings 的
// `codeHighlight` / `codeLineNumbers`），此前渲染层零消费方：开关拨了没反应。
// 本 hook 把它们接上——消息区的代码块据此决定是否着色、是否显示行号槽。
//
// 读取路径沿用仓内既有约定：window.__KHYOS__.getSettings() 桥（与
// ContextUsage.tsx 读 contextUsagePanelPos、theme/theme.ts 读 messageFontSize
// 同一模式）。
//
// 刷新时机：模块级缓存 + TTL。设置页是整屏路由（App.tsx 的 settings 分支
// 直接 return，不与消息区共存），从设置返回时消息区整块重挂载，本 hook
// 重新读一次即可拿到新值；此外窗口重新获得焦点时也刷新一次。
//
// 关于「Shiki」二字：设置页文案写的是 Shiki 高亮，而本轮明确不引入新依赖
// （仓库同时存在 pnpm-lock.yaml 与 package-lock.json，且多个子代理并行改
// 文件）。因此本 hook 兑现的是开关语义本身——高亮开/关、行号开/关——着色
// 引擎仍是内置的轻量高亮器（MarkdownRenderer 的 highlightCode）。设置页文案
// 属于设置区域，不在本区域改动范围内；文案与降级实现的对齐由设置区域负责。

import { useEffect, useState } from 'react'

export interface CodeDisplaySettings {
  /** 关闭时输出纯文本代码（<pre><code>），不做任何着色。 */
  highlight: boolean
  /** 开启时在 pre 左侧加行号槽。 */
  lineNumbers: boolean
}

// 与 AppearanceSettings 的默认值口径一致：codeHighlight 缺省为开
// （`settings.codeHighlight !== false`），codeLineNumbers 缺省为关
// （`settings.codeLineNumbers === true`）。
const DEFAULTS: CodeDisplaySettings = { highlight: true, lineNumbers: false }

// 缓存新鲜期：设置页整屏切换回来时消息区重挂载，超过这个时长就重读。
const CACHE_TTL_MS = 1000

let cache: CodeDisplaySettings | null = null
let cacheAt = 0
let inFlight: Promise<CodeDisplaySettings> | null = null
// 读取代号：invalidate 时自增。代号不一致的读取结果视为过期，不写缓存、
// 不通知监听方——否则「写入设置后立刻重读」会被写入前发出的那次读取覆盖。
let readToken = 0
const listeners = new Set<(s: CodeDisplaySettings) => void>()

function toSettings(raw: Record<string, unknown> | undefined): CodeDisplaySettings {
  if (!raw) return DEFAULTS
  return {
    highlight: raw.codeHighlight !== false,
    lineNumbers: raw.codeLineNumbers === true,
  }
}

function read(): Promise<CodeDisplaySettings> {
  if (inFlight) return inFlight
  const api = (window as unknown as {
    __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
  }).__KHYOS__
  if (!api?.getSettings) {
    cache = DEFAULTS
    cacheAt = Date.now()
    return Promise.resolve(DEFAULTS)
  }
  const token = readToken
  const req = api.getSettings()
    .then((raw) => {
      if (token !== readToken) return cache ?? DEFAULTS // 已被 invalidate 取代，丢弃
      cache = toSettings(raw)
      cacheAt = Date.now()
      listeners.forEach(fn => fn(cache!))
      return cache
    })
    .catch(() => {
      // fail-soft：读不到就沿用默认值，不影响代码块渲染
      if (token !== readToken) return cache ?? DEFAULTS
      cache = DEFAULTS
      cacheAt = Date.now()
      return cache
    })
  // 并发去重只覆盖「正在进行中」的那次读取；读完之后必须放开，否则
  // invalidate 之后的重读会拿到上一次已 resolve 的 promise，拿到旧值。
  const p = req.finally(() => {
    if (inFlight === p) inFlight = null
  })
  inFlight = p
  return p
}

/**
 * 订阅代码展示设置。多个代码块共享同一份读取（模块级缓存 + 并发去重），
 * 避免每来一个代码块就打一次 IPC。
 */
export function useCodeDisplaySettings(): CodeDisplaySettings {
  const [settings, setSettings] = useState<CodeDisplaySettings>(cache ?? DEFAULTS)

  useEffect(() => {
    let alive = true
    const onChange = (s: CodeDisplaySettings) => { if (alive) setSettings(s) }
    listeners.add(onChange)

    const refresh = () => {
      if (cache && Date.now() - cacheAt < CACHE_TTL_MS) {
        onChange(cache)
        return
      }
      void read().then(onChange)
    }
    refresh()

    // 窗口重新获得焦点时刷新：设置页在同一窗口内改的开关，回到消息区即可见
    const onFocus = () => { cacheAt = 0; refresh() }
    window.addEventListener('focus', onFocus)

    return () => {
      alive = false
      listeners.delete(onChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return settings
}

/**
 * 作废缓存并重读，使「语法高亮 / 行号显示」两个开关在写入后立刻生效，
 * 不用重开应用。设置页在 settings:set 落盘完成后调用本函数
 * （SettingsPage 的 updateSetting）。
 */
export function invalidateCodeDisplaySettings(): void {
  cache = null
  cacheAt = 0
  // 自增代号：让写入前发出的那次读取作废，并放开并发去重，强制重新拉一次
  readToken++
  inFlight = null
  void read()
}
