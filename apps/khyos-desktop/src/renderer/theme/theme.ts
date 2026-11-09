// khy-canary: Khy-20261102-350-M58K00MH
// renderer theme — applies ZCode theme classes to <html> (ZC-ALIGN-003 B4).
//
// The persisted theme value is one of 'system' | 'dark' | 'light' (the same
// radio options AppearanceSettings exposes). DOM classes in globals.css:
//   - .theme-zai-light  → light token set
//   - :root / .dark / .theme-zai-dark → dark token set (dark is the default,
//     so leaving both classes off yields dark)
//
// 主题类名就是**全部**主题层（色彩令牌 / 字体栈 / 阴影 / color-scheme）的开关：
// 令牌值本身全部住在 globals.css，本模块只切类名，不直接写任何 CSS 变量 ——
// 新增令牌时只改 globals.css 一处即可，不要在这里另开一条覆盖路径。
//
// 'system' resolves against the OS prefers-color-scheme media query and re-resolves
// live when it flips; 'dark'/'light' pin the matching class.
//
// This module is the single place that mutates the theme DOM class so the
// startup load, the onThemeChanged IPC listener, and AppearanceSettings all stay in sync.

const THEME_CLASSES = ['theme-zai-dark', 'theme-zai-light'] as const

type ThemeMode = 'system' | 'dark' | 'light'

// Tracks the last-applied mode so the OS-scheme listener can tell "system
// pinned light" apart from an explicit "light" pin (both carry the same
// DOM class). Updated by every applyTheme/applyThemeClass call.
let activeMode: ThemeMode = 'system'

function normalizeMode(value: unknown): ThemeMode {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (v === 'dark' || v === 'light') return v
  return 'system'
}

/** Resolve a 'system' mode to a concrete dark/light using the OS preference. */
function resolveSystemMode(): 'dark' | 'light' {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyThemeClass(mode: ThemeMode): void {
  activeMode = mode
  const root = document.documentElement
  const concrete = mode === 'system' ? resolveSystemMode() : mode
  const next = concrete === 'light' ? 'theme-zai-light' : 'theme-zai-dark'
  if (root.classList.contains(next)) return // idempotent: already correct
  THEME_CLASSES.forEach((c) => root.classList.remove(c))
  root.classList.add(next)
  // 底图这类「按主题选素材」的消费方不在本模块内 —— 只广播一次类已落定，
  // 由它们自己重挑一套（theme/background.ts 监听 khy:theme-applied）。
  window.dispatchEvent(new CustomEvent<string>('khy:theme-applied', { detail: next }))
}

/** Apply a persisted theme mode to the DOM. Idempotent; safe to call repeatedly. */
export function applyTheme(mode: unknown): void {
  applyThemeClass(normalizeMode(mode))
}

/**
 * Apply the persisted message font size as the --khy-message-font-size CSS
 * var on <html> (consumed by MarkdownRenderer's message body root). Falls
 * back to the default 14px for any non-numeric value.
 */
export function applyMessageFontSize(value: unknown): void {
  const n = typeof value === 'number' ? value : Number(value)
  const px = Number.isFinite(n) && n >= 12 && n <= 20 ? `${n}px` : '14px'
  document.documentElement.style.setProperty('--khy-message-font-size', px)
}

/**
 * Load the persisted message font size from main and apply it on startup
 * (parallel of loadTheme for the font-size appearance setting).
 */
export async function loadMessageFontSize(): Promise<void> {
  const api = (window as unknown as {
    __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
  }).__KHYOS__
  const settings = await api?.getSettings?.().catch(() => undefined)
  if (settings) applyMessageFontSize(settings.messageFontSize)
}

/**
 * Load the persisted theme from main and apply it on startup.
 * Falls back to 'system' if IPC is unavailable (dev/browser context).
 */
export async function loadTheme(): Promise<void> {
  const api = (window as unknown as {
    __KHYOS__?: { getTheme?: () => Promise<string> }
  }).__KHYOS__
  const theme = (await api?.getTheme?.().catch(() => 'system')) || 'system'
  applyTheme(theme)
}

/**
 * Subscribe to live theme changes: re-applies on the `theme:changed` IPC
 * event (emitted by main after every persisted set) AND on OS
 * color-scheme flips while the active mode is 'system'.
 *
 * Returns an unsubscribe function for React effect cleanup.
 */
export function subscribeToTheme(): () => void {
  const api = (window as unknown as {
    __KHYOS__?: { onThemeChanged?: (cb: (mode: string) => void) => () => void }
  }).__KHYOS__

  const unsubIpc = api?.onThemeChanged?.((mode: string) => {
    applyTheme(mode)
  })

  // 'system' must follow the OS scheme live; pinned dark/light must NOT.
  const mql = window.matchMedia?.('(prefers-color-scheme: light)')
  const onScheme = () => {
    if (activeMode === 'system') applyTheme('system')
  }
  mql?.addEventListener('change', onScheme)
  return () => {
    unsubIpc?.()
    mql?.removeEventListener('change', onScheme)
  }
}
