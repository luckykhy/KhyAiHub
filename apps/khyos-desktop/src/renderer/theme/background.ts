// 品牌背景 —— 深浅两套预设表 + 唯一的 CSS 变量写入点（与 theme.ts 同一分工：
// 变量值住在 globals.css，本模块只切值）。
//
// globals.css 的 .khy-brand-main 在深浅两个主题下都读同一组 --khy-bg-* 变量；
// 本模块按**当前生效主题**挑预设并整组重写，所以切主题就是换一套壁纸。
// 两套各有自己的选中项（desktopBackground / desktopBackgroundLight），
// 浅色下点过「素笺」，切回深色仍是原来的品牌环，互不覆盖。
// 自定义图片只有一份（desktopBackgroundImage），两套主题共用，色温靠遮罩换：
// 深色压墨、浅色铺白。
//
// 自定义图片先经 main 的 fs:readImageDataUrl 读成 data URL —— 渲染层跑在
// file:// 上，直接 url(file://…) 会被当成跨源。GIF 同样走 data URL：
// background-image 会自己播放动画。

import brandRing from '../assets/background/khyos-backdrop.jpg'
import gateway from '../assets/background/khyos-gateway.jpg'
import terminal from '../assets/background/khyos-terminal.jpg'
import lightPorcelain from '../assets/background/khyos-light-porcelain.jpg'
import lightMist from '../assets/background/khyos-light-mist.jpg'
import lightGrid from '../assets/background/khyos-light-grid.jpg'

export type BackgroundTheme = 'dark' | 'light'

export interface BackgroundPreset {
  id: string
  theme: BackgroundTheme
  name: string
  hint: string
  image?: string
  position?: string
  overlay?: string
}

// 左 60% 是消息列与问候语，必须压到几乎看不出底图；右侧留一点暖光。
const DEFAULT_OVERLAY =
  'linear-gradient(100deg, rgba(8, 12, 20, 0.93) 0%, rgba(8, 12, 20, 0.88) 42%, rgba(8, 12, 20, 0.6) 100%)'
// 自定义图不认识内容，左半压得更狠：宁可让图退成纹理，也不和正文抢对比度。
const CUSTOM_OVERLAY =
  'linear-gradient(100deg, rgba(8, 12, 20, 0.95) 0%, rgba(8, 12, 20, 0.9) 45%, rgba(8, 12, 20, 0.66) 100%)'
// 纯墨蓝：不给图，用品牌暖光 + 三层墨色撑住层次。
const INK_OVERLAY =
  'radial-gradient(900px 620px at 84% 42%, rgba(226, 112, 58, 0.16), rgba(8, 12, 20, 0) 68%), linear-gradient(118deg, #0a0e16 0%, #0c121d 52%, #111927 100%)'

// 浅色：底色对齐 .theme-zai-light 的 --color-background（#f6f7f9），
// 左侧压到接近纯白保证正文对比度，右侧只留一层薄纱看得到壁纸。
const LIGHT_OVERLAY =
  'linear-gradient(100deg, rgba(246, 247, 249, 0.95) 0%, rgba(246, 247, 249, 0.9) 42%, rgba(246, 247, 249, 0.35) 100%)'
const CUSTOM_LIGHT_OVERLAY =
  'linear-gradient(100deg, rgba(246, 247, 249, 0.97) 0%, rgba(246, 247, 249, 0.93) 45%, rgba(246, 247, 249, 0.6) 100%)'
// 素笺：不给图，米白纸面 + 右侧一点品牌暖光，深浅两套里最省显存。
const PAPER_OVERLAY =
  'radial-gradient(900px 620px at 84% 42%, rgba(226, 112, 58, 0.12), rgba(246, 247, 249, 0) 68%), linear-gradient(118deg, #fbfcfd 0%, #f4f6f8 55%, #eef1f4 100%)'

export const DEFAULT_BACKGROUND_ID = 'brand-ring'
export const LIGHT_DEFAULT_BACKGROUND_ID = 'light-paper'
export const CUSTOM_BACKGROUND_ID = 'custom'

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: DEFAULT_BACKGROUND_ID,
    theme: 'dark',
    name: '品牌环',
    hint: '四段弧叶与 K 内核悬在湿地上，暖金环收在右侧',
    image: brandRing,
    position: '88% 45%',
    overlay: DEFAULT_OVERLAY,
  },
  {
    id: 'gateway',
    theme: 'dark',
    name: '网关星图',
    hint: '执行轨迹汇入右侧环形网关，青白光带做导航',
    image: gateway,
    position: '84% 52%',
    overlay: DEFAULT_OVERLAY,
  },
  {
    id: 'terminal',
    theme: 'dark',
    name: '终端织网',
    hint: '磨砂玻璃后的菱形织网，暗到只当纹理',
    image: terminal,
    position: '80% 50%',
    overlay:
      'linear-gradient(100deg, rgba(8, 12, 20, 0.94) 0%, rgba(8, 12, 20, 0.9) 46%, rgba(8, 12, 20, 0.64) 100%)',
  },
  {
    id: 'ink',
    theme: 'dark',
    name: '纯墨蓝',
    hint: '不铺图，只留品牌暖光与墨色渐变，最省显存',
    overlay: INK_OVERLAY,
  },
]

export const LIGHT_BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: LIGHT_DEFAULT_BACKGROUND_ID,
    theme: 'light',
    name: '素笺',
    hint: '不铺图，米白纸面加右侧一点暖光，最省显存',
    overlay: PAPER_OVERLAY,
  },
  {
    id: 'light-porcelain',
    theme: 'light',
    name: '白瓷微光',
    hint: '瓷白底上一枚暖金品牌环，水波把光散在右下',
    image: lightPorcelain,
    position: '86% 46%',
    overlay: LIGHT_OVERLAY,
  },
  {
    id: 'light-mist',
    theme: 'light',
    name: '晨雾庭园',
    hint: '石墙与晨雾，暖光从右侧窗洞透进来',
    image: lightMist,
    position: '82% 50%',
    overlay: LIGHT_OVERLAY,
  },
  {
    id: 'light-grid',
    theme: 'light',
    name: '浅格蓝图',
    hint: '磨砂玻璃后的菱格与一道金色斜光，只当纹理',
    image: lightGrid,
    position: '88% 52%',
    overlay: LIGHT_OVERLAY,
  },
]

type BackgroundApi = {
  getSettings?: () => Promise<Record<string, unknown>>
  readImageDataUrl?: (path: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
}

function backgroundApi(): BackgroundApi | undefined {
  return (window as unknown as { __KHYOS__?: BackgroundApi }).__KHYOS__
}

export function presetsForTheme(theme: BackgroundTheme): BackgroundPreset[] {
  return theme === 'light' ? LIGHT_BACKGROUND_PRESETS : BACKGROUND_PRESETS
}

export function defaultBackgroundId(theme: BackgroundTheme): string {
  return theme === 'light' ? LIGHT_DEFAULT_BACKGROUND_ID : DEFAULT_BACKGROUND_ID
}

/** 两套主题各自的选中项键名：切主题不会把另一套的壁纸硬套过来。 */
export function backgroundSettingKey(theme: BackgroundTheme): 'desktopBackground' | 'desktopBackgroundLight' {
  return theme === 'light' ? 'desktopBackgroundLight' : 'desktopBackground'
}

/**
 * 当前生效主题。theme.ts 写在 <html> 上的类就是唯一真相（它同时处理
 * 'system' 与 OS 深浅色翻转）；首帧类还没写上时，才回落到设置值与系统偏好。
 */
export function resolvedBackgroundTheme(settings: Record<string, unknown> = {}): BackgroundTheme {
  const root = document.documentElement
  if (root.classList.contains('theme-zai-light')) return 'light'
  if (root.classList.contains('theme-zai-dark')) return 'dark'
  const mode = settings.theme
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function presetById(theme: BackgroundTheme, id: string): BackgroundPreset {
  const presets = presetsForTheme(theme)
  return presets.find((p) => p.id === id) ?? presets[0]
}

function setBackgroundVars(image: string | undefined, position: string, overlay: string): void {
  const style = document.documentElement.style
  style.setProperty('--khy-bg-overlay', overlay)
  style.setProperty('--khy-bg-position', position)
  // 无图预设必须显式写 none：删掉变量会落回 CSS 的 var() 兜底（深色品牌环），
  // 「纯墨蓝 / 素笺」就变成了品牌环。
  style.setProperty('--khy-bg-image', image ? `url("${image}")` : 'none')
}

function applyPreset(theme: BackgroundTheme, id: string): void {
  const preset = presetById(theme, id)
  setBackgroundVars(
    preset.image,
    preset.position ?? 'center',
    preset.overlay ?? (theme === 'light' ? LIGHT_OVERLAY : DEFAULT_OVERLAY),
  )
}

/** 最近一次应用的设置：主题切换（类变化）时据此重挑另一套壁纸。 */
let lastSettings: Record<string, unknown> = {}

/** 按主题挑预设：自定义图读取失败时回退到该主题的默认预设并带回原因。 */
export async function applyBackground(
  settings: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  lastSettings = settings
  const theme = resolvedBackgroundTheme(settings)
  const key = backgroundSettingKey(theme)
  const fallbackId = defaultBackgroundId(theme)
  const fallbackName = presetById(theme, fallbackId).name
  const rawId = typeof settings[key] === 'string' ? (settings[key] as string) : ''
  const presets = presetsForTheme(theme)
  const known = rawId === CUSTOM_BACKGROUND_ID || presets.some((p) => p.id === rawId)
  const id = known ? rawId : fallbackId

  if (id !== CUSTOM_BACKGROUND_ID) {
    applyPreset(theme, id)
    return { ok: true }
  }

  const filePath =
    typeof settings.desktopBackgroundImage === 'string' ? settings.desktopBackgroundImage.trim() : ''
  if (!filePath) {
    applyPreset(theme, fallbackId)
    return { ok: false, error: `还没有选自定义图片，已回退${fallbackName}` }
  }
  const readImage = backgroundApi()?.readImageDataUrl
  if (!readImage) {
    applyPreset(theme, fallbackId)
    return { ok: false, error: `当前环境读不了本地图片，已回退${fallbackName}` }
  }
  const result = await readImage(filePath).catch(() => undefined)
  if (!result?.ok || !result.dataUrl) {
    applyPreset(theme, fallbackId)
    return { ok: false, error: result?.error || `读取 ${filePath} 失败，已回退${fallbackName}` }
  }
  setBackgroundVars(result.dataUrl, 'center', theme === 'light' ? CUSTOM_LIGHT_OVERLAY : CUSTOM_OVERLAY)
  return { ok: true }
}

/** 启动时从主进程读设置并应用（与 loadTheme 同一条自举路径）。 */
export async function loadBackground(): Promise<void> {
  const settings = await backgroundApi()?.getSettings?.().catch(() => undefined)
  await applyBackground(settings || {})
  // 主题类由 theme.ts 落定后派发 khy:theme-applied；这里按**已生效的类**
  // 重挑一套，深色壁纸不会残留在浅色界面里，反之亦然。
  window.addEventListener('khy:theme-applied', () => {
    void applyBackground(lastSettings)
  })
}
