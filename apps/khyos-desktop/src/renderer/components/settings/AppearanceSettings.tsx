// khy-canary: Khy-20261102-306-RV9NYXWT
import { useState, useEffect } from 'react'
import { applyTheme, applyMessageFontSize } from '../../theme/theme'
import {
  CUSTOM_BACKGROUND_ID,
  applyBackground,
  backgroundSettingKey,
  defaultBackgroundId,
  presetsForTheme,
  type BackgroundTheme,
} from '../../theme/background'
import { SettingSection, ToggleField, SelectField, RadioField, ActionField } from './fields'
import { Icon } from '../ui/Icon'

// ── 外观 settings page (ZC-ALIGN-002 I 区, account menu 界面主题/界面缩放 子菜单) ──
// Theme switching via window.__KHYOS__.setTheme IPC (preload already exposes this).
// a11y evidence: account menu s-44 界面主题 radio (系统默认/深色/浅色，选中项带勾选记号),
// s-46 界面缩放 (放大/缩小/实际大小 Ctrl+0 disabled).
// 字段组件统一来自 ./fields.tsx（本页不再自带副本）。

interface AppearanceSettingsProps {
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

type AppearanceFileApi = {
  selectFiles?: (
    filters?: { name: string; extensions: string[] }[]
  ) => Promise<{ path: string; size: number }[]>
  readImageDataUrl?: (path: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
}

function appearanceFileApi(): AppearanceFileApi | undefined {
  return (window as unknown as { __KHYOS__?: AppearanceFileApi }).__KHYOS__
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function AppearanceSettings({ settings, onChange }: AppearanceSettingsProps) {
  const [theme, setTheme] = useState('system')
  const [systemLight, setSystemLight] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: light)').matches === true,
  )
  const [backgroundError, setBackgroundError] = useState('')
  const [customPreview, setCustomPreview] = useState('')
  const [customPreviewError, setCustomPreviewError] = useState('')

  // 底图卡片跟着**生效主题**走：系统默认时由 OS 深浅色决定，固定档由 radio 决定。
  // 浅色/深色各有自己的选中项，切主题只换对应那套，不会互相覆盖。
  const effectiveTheme: BackgroundTheme =
    theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : systemLight ? 'light' : 'dark'
  const isLight = effectiveTheme === 'light'
  const activeKey = backgroundSettingKey(effectiveTheme)
  const activePresets = presetsForTheme(effectiveTheme)
  const activeDefaultId = defaultBackgroundId(effectiveTheme)

  const savedBackgroundId = typeof settings[activeKey] === 'string' ? (settings[activeKey] as string) : ''
  // 未知值（旧版本遗留 / 手改 settings.json）按该套默认项显示，别让整排卡片都没有选中态。
  const backgroundId =
    savedBackgroundId === CUSTOM_BACKGROUND_ID ||
    activePresets.some((p) => p.id === savedBackgroundId)
      ? savedBackgroundId
      : activeDefaultId
  const customImagePath =
    typeof settings.desktopBackgroundImage === 'string' ? settings.desktopBackgroundImage : ''

  // Load current theme on mount
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getTheme?: () => Promise<string> }
    }).__KHYOS__
    api?.getTheme?.().then((t) => setTheme(t || 'system')).catch(() => {})
  }, [])

  // 主题也可能从账号菜单换（或系统深浅色翻转）：跟着 DOM 已落定的类同步，
  // 否则这里会显示上一套底图卡片，和真实界面不一致。
  useEffect(() => {
    const onApplied = () => {
      const api = (window as unknown as {
        __KHYOS__?: { getTheme?: () => Promise<string> }
      }).__KHYOS__
      api?.getTheme?.().then((t) => setTheme(t || 'system')).catch(() => {})
    }
    const mql = window.matchMedia?.('(prefers-color-scheme: light)')
    const onScheme = () => setSystemLight(mql?.matches === true)
    window.addEventListener('khy:theme-applied', onApplied)
    mql?.addEventListener('change', onScheme)
    return () => {
      window.removeEventListener('khy:theme-applied', onApplied)
      mql?.removeEventListener('change', onScheme)
    }
  }, [])

  // 自定义背景的缩略图：读不到就如实报错，不拿旧图顶替。
  useEffect(() => {
    let alive = true
    if (backgroundId !== CUSTOM_BACKGROUND_ID || !customImagePath) {
      setCustomPreview('')
      setCustomPreviewError('')
      return
    }
    const read = appearanceFileApi()?.readImageDataUrl
    if (!read) return
    read(customImagePath)
      .then((res) => {
        if (!alive) return
        if (res?.ok && res.dataUrl) {
          setCustomPreview(res.dataUrl)
          setCustomPreviewError('')
        } else {
          setCustomPreview('')
          setCustomPreviewError(res?.error || `读取 ${customImagePath} 失败`)
        }
      })
      .catch(() => {
        if (alive) setCustomPreviewError(`读取 ${customImagePath} 失败`)
      })
    return () => {
      alive = false
    }
  }, [backgroundId, customImagePath])

  const selectBackground = (id: string) => {
    setBackgroundError('')
    onChange(activeKey, id)
    void applyBackground({ ...settings, [activeKey]: id })
  }

  const pickCustomBackground = async () => {
    setBackgroundError('')
    const api = appearanceFileApi()
    if (!api?.selectFiles) {
      setBackgroundError('当前环境不支持选择文件，请在桌面版设置背景')
      return
    }
    const files = await api
      .selectFiles([{ name: '图片 / 动态图', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'] }])
      .catch(() => [])
    const picked = files?.[0]
    if (!picked) return
    onChange('desktopBackgroundImage', picked.path)
    onChange(activeKey, CUSTOM_BACKGROUND_ID)
    const result = await applyBackground({
      ...settings,
      desktopBackgroundImage: picked.path,
      [activeKey]: CUSTOM_BACKGROUND_ID,
    })
    if (!result.ok) setBackgroundError(result.error || '自定义背景应用失败')
  }

  const clearCustomBackground = () => {
    setBackgroundError('')
    onChange('desktopBackgroundImage', '')
    onChange(activeKey, activeDefaultId)
    void applyBackground({ ...settings, desktopBackgroundImage: '', [activeKey]: activeDefaultId })
  }

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme)
    // 立即应用到 DOM（预览），同时持久化到主进程 settings.json。
    // 主进程随后广播 theme:changed，App.tsx 的订阅会再次 applyTheme（幂等）。
    applyTheme(newTheme)
    const api = (window as unknown as {
      __KHYOS__?: { setTheme?: (mode: string) => Promise<void> }
    }).__KHYOS__
    api?.setTheme?.(newTheme).catch(() => {})
    onChange('theme', newTheme)
  }

  return (
    <div className="max-w-3xl">
      {/* ── 主题 ── */}
      <SettingSection title="主题">
        <RadioField
          label="界面主题"
          description="选择应用外观主题。系统默认跟随操作系统深浅色设置。"
          value={theme}
          options={[
            { value: 'system', label: '系统默认' },
            { value: 'dark', label: '深色主题' },
            { value: 'light', label: '浅色主题' },
          ]}
          onChange={handleThemeChange}
        />
      </SettingSection>

      {/* ── 背景 ── */}
      <SettingSection title="背景">
        <div className="py-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">工作区底图</span>
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[11px] text-foreground-muted">
              {isLight ? '浅色系列' : '深色系列'}
            </span>
          </div>
          <div className="text-xs text-foreground-muted mt-1 mb-3 leading-relaxed">
            {`深色与浅色各有一整套，随界面主题自动切换；切到${isLight ? '深色' : '浅色'}主题可编辑另一套。`}
            <br />
            自定义支持 PNG / JPG / GIF（GIF 会动），两套主题共用同一张图；移动或删除原文件后需要重新选择。
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {activePresets.map((preset) => {
              const selected = backgroundId === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => selectBackground(preset.id)}
                  aria-pressed={selected}
                  title={preset.hint}
                  className={`text-left rounded-lg border overflow-hidden transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                    selected
                      ? 'border-brand ring-1 ring-brand'
                      : 'border-card-border hover:border-border-hover'
                  }`}
                >
                  <span className="block aspect-[16/10] bg-sidebar overflow-hidden">
                    {preset.image ? (
                      <img
                        src={preset.image}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      // 无图预设（纯墨蓝 / 素笺）直接用它的渐变层当缩略图：
                      // 是实际铺上去的那一套，不拿假截图冒充。
                      <span className="block h-full w-full" style={{ backgroundImage: preset.overlay }} />
                    )}
                  </span>
                  <span className="block px-2 py-2">
                    <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                      {preset.name}
                      {selected && <Icon name="check" size={12} className="text-brand" />}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-foreground-muted">
                      {preset.hint}
                    </span>
                  </span>
                </button>
              )
            })}

            <button
              type="button"
              onClick={() => void pickCustomBackground()}
              aria-pressed={backgroundId === CUSTOM_BACKGROUND_ID}
              title="选择本地图片或 GIF 作为底图"
              className={`text-left rounded-lg border overflow-hidden transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                backgroundId === CUSTOM_BACKGROUND_ID
                  ? 'border-brand ring-1 ring-brand'
                  : 'border-card-border hover:border-border-hover'
              }`}
            >
              <span className="flex aspect-[16/10] items-center justify-center bg-sidebar overflow-hidden">
                {customPreview ? (
                  <img src={customPreview} alt="" className="h-full w-full object-cover" draggable={false} />
                ) : (
                  <span className="px-2 text-center text-xs text-foreground-muted">
                    {customImagePath ? '缩略图不可用' : '选择图片 / GIF'}
                  </span>
                )}
              </span>
              <span className="block px-2 py-2">
                <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                  自定义
                  {backgroundId === CUSTOM_BACKGROUND_ID && (
                    <Icon name="check" size={12} className="text-brand" />
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-foreground-muted">
                  {customImagePath ? fileNameOf(customImagePath) : 'PNG / JPG / GIF / WebP'}
                </span>
              </span>
            </button>
          </div>

          {customImagePath && (
            <div className="mt-3 flex items-center gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate text-foreground-muted" title={customImagePath}>
                {customImagePath}
              </span>
              <button
                type="button"
                onClick={() => void pickCustomBackground()}
                className="text-brand hover:underline"
              >
                更换
              </button>
              <button
                type="button"
                onClick={clearCustomBackground}
                className="text-foreground-muted hover:text-foreground"
              >
                移除
              </button>
            </div>
          )}

          {customPreviewError && (
            <div className="mt-2 text-xs leading-relaxed text-red-400">
              自定义底图不可用：{customPreviewError}
            </div>
          )}
          {backgroundError && (
            <div className="mt-2 text-xs leading-relaxed text-red-400">{backgroundError}</div>
          )}
        </div>
      </SettingSection>

      {/* ── 缩放 ── */}
      <SettingSection title="缩放">
        <ActionField
          label="界面缩放"
          description="使用快捷键 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复实际大小。"
          buttonText="实际大小"
          onClick={() => {
            // Reset to 100% via zoom:set IPC (main clamps + applies to sender)
            const api = (window as unknown as {
              __KHYOS__?: { setZoomFactor?: (factor: number) => Promise<number> }
            }).__KHYOS__
            api?.setZoomFactor?.(1).catch(() => {})
          }}
        />
      </SettingSection>

      {/* ── 代码高亮 ── */}
      {/* 开关已兑现：写入的 codeHighlight / codeLineNumbers 由渲染层消费
          （message 区的 MarkdownRenderer 与 viewer 区的源码视图）。
          文案不写「Shiki」——本轮未引入该依赖，着色走内置轻量高亮器，
          写引擎名会与实际行为不符（设计稿 §4.1 降级案）。 */}
      <SettingSection title="代码高亮">
        <ToggleField
          label="代码块语法高亮"
          description="在消息流的代码块中启用语法高亮。"
          enabled={settings.codeHighlight !== false}
          onChange={(v) => onChange('codeHighlight', v)}
        />
        <ToggleField
          label="行号显示"
          description="在消息流与代码查看器的代码块中显示行号。"
          enabled={settings.codeLineNumbers === true}
          onChange={(v) => onChange('codeLineNumbers', v)}
        />
      </SettingSection>

      {/* ── 字体 ── */}
      <SettingSection title="字体">
        <SelectField
          label="消息字体大小"
          description="调整消息流正文的字体大小。"
          value={(settings.messageFontSize as string) || '14'}
          onChange={(v) => {
            // Persist via settings:set + apply immediately as the
            // --khy-message-font-size CSS var (consumed by MarkdownRenderer)
            onChange('messageFontSize', v)
            applyMessageFontSize(v)
          }}
          options={[
            { value: '13', label: '小' },
            { value: '14', label: '中' },
            { value: '15', label: '大' },
            { value: '16', label: '更大' },
          ]}
        />
      </SettingSection>
    </div>
  )
}
