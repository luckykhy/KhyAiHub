// khy-canary: Khy-20261102-317-0R8KGCDZ
// ── 设置页字段组件（单一定义）──
// 此前 SettingSection / ToggleField / SelectField / RadioField / ActionField
// （另有 SaveField / PathField / TextField）在 AppearanceSettings、GeneralSettings、
// BrowserCuaSettings、OnboardingSettings 四处逐字复制，样式必然随时间漂移。
// 现全部收敛到本文件，四个页面改为 import——改一行四页同步生效。
//
// 视觉基线以原 AppearanceSettings 版本为准，其余三处逐个 diff 核对后并入
// （GeneralSettings 的 SelectField 多一个 disabled、SaveField/PathField，
// BrowserCuaSettings 的 TextField 提交时机在 blur）。
// 交互口径统一按设计稿 §2.4：微反馈 120–150ms，缓动走 transition 默认 ease-out；
// prefers-reduced-motion 由 globals.css 的全局降级块兜底。
import type { ReactNode } from 'react'
import { useState, useEffect, useCallback } from 'react'
import { Icon } from '../ui/Icon'

// 焦点环：面板底色上偏移，保证蓝环与底之间有一圈 card 色（§2.1 焦点环 ≥3:1）
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card'

// 行布局：所有「左文案 + 右控件」的行共用，保证同一设置页内行高/间距一致
function FieldRow({ label, description, children }: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between py-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-foreground-muted mt-1 leading-relaxed">{description}</div>
      </div>
      {children}
    </div>
  )
}

// 文案在上、控件在下的布局（单选组、输入框、路径/保存等）
function FieldBlock({ label, description, children }: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="py-4">
      <div className="text-sm font-medium text-foreground mb-1">{label}</div>
      <div className="text-xs text-foreground-muted mb-3 leading-relaxed">{description}</div>
      {children}
    </div>
  )
}

const TEXT_INPUT =
  'bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-input-border-focused'

const GHOST_BUTTON =
  'px-4 py-2 text-sm font-medium rounded-lg transition duration-150 flex-shrink-0 border border-card-border text-foreground/70 hover:text-foreground hover:bg-surface-hover active:scale-[0.98] ' +
  FOCUS_RING

// ── 分区 ──
export function SettingSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-sm font-medium text-foreground mb-3 px-1">{title}</h3>
      <div className="bg-card border border-card-border rounded-xl px-5 divide-y divide-card-border">
        {children}
      </div>
    </div>
  )
}

// ── 开关 ──
// 轨道开态用 --color-brand（原为品牌令牌），关态用 foreground/20；
// 拇指保持 bg-white，在蓝轨道与灰轨道上都有边界。
export function ToggleField({ label, description, enabled, onChange, disabled = false }: {
  label: string
  description: string
  enabled: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <FieldRow label={label} description={description}>
      <button
        onClick={() => !disabled && onChange(!enabled)}
        aria-label={label}
        disabled={disabled}
        className={`relative w-11 h-6 rounded-full transition duration-150 flex-shrink-0 cursor-pointer hover:opacity-90 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING} ${
          enabled ? 'bg-brand' : 'bg-foreground/20'
        }`}
        role="switch"
        aria-checked={enabled}
      >
        <span
          className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </FieldRow>
  )
}

// ── 下拉 ──
export function SelectField({ label, description, value, onChange, options, disabled = false }: {
  label: string
  description: string
  value: string
  onChange?: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <FieldRow label={label} description={description}>
      <select
        value={value}
        onChange={disabled ? undefined : (e) => onChange?.(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className={`khy-select bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground transition-colors duration-150 focus:outline-none focus:border-input-border-focused min-w-[140px] flex-shrink-0 cursor-pointer ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        }`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </FieldRow>
  )
}

// ── 单选组 ──
// 选中态：整行给 brand-subtle 低透明底（§2.1 新令牌，浅色主题下是淡蓝不是黑块），
// 行尾用 Icon 注册表的 check 字形，不再用 Unicode 勾字符（§3.1 A 类）。
export function RadioField({ label, description, value, onChange, options }: {
  label: string
  description: string
  value: string
  onChange: (v: string) => void
  // preview 是可选的缩略图（选项本身就是形象时用，例如桌宠角色二选一）。
  // 给了 preview 就渲染图片，不给则维持纯文字行。
  options: { value: string; label: string; preview?: string }[]
}) {
  return (
    <FieldBlock label={label} description={description}>
      <div className="flex flex-col gap-2">
        {options.map((opt) => {
          const selected = value === opt.value
          return (
            <label
              key={opt.value}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-150 ${
                selected ? 'bg-brand-subtle' : 'hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name={label}
                value={opt.value}
                checked={selected}
                onChange={() => onChange(opt.value)}
                className="w-4 h-4 accent-brand"
              />
              {opt.preview && (
                <img
                  src={opt.preview}
                  alt=""
                  aria-hidden="true"
                  className="w-9 h-9 rounded-md object-contain bg-background/60 flex-shrink-0"
                />
              )}
              <span className="text-sm text-foreground">{opt.label}</span>
              {selected && (
                <span className="ml-auto text-brand">
                  <Icon name="check" size={12} />
                </span>
              )}
            </label>
          )
        })}
      </div>
    </FieldBlock>
  )
}

// ── 动作按钮行 ──
export function ActionField({ label, description, buttonText, onClick }: {
  label: string
  description: string
  buttonText: string
  onClick: () => void
}) {
  return (
    <FieldRow label={label} description={description}>
      <button onClick={onClick} className={GHOST_BUTTON}>
        {buttonText}
      </button>
    </FieldRow>
  )
}

// ── 文本框 + 保存（本地草稿，点保存才落盘）──
export function SaveField({ label, description, value, placeholder, onChange }: {
  label: string
  description: string
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  const [localValue, setLocalValue] = useState(value)
  const [dirty, setDirty] = useState(false)

  const handleChange = (v: string) => {
    setLocalValue(v)
    setDirty(v !== value)
  }

  const handleSave = () => {
    onChange(localValue)
    setDirty(false)
  }

  return (
    <FieldBlock label={label} description={description}>
      <div className="flex gap-2">
        <input
          type="text"
          value={localValue}
          placeholder={placeholder}
          onChange={(e) => handleChange(e.target.value)}
          className={`${TEXT_INPUT} flex-1 ${FOCUS_RING}`}
        />
        <button
          onClick={handleSave}
          disabled={!dirty}
          className={`bg-brand-subtle text-brand px-4 py-2 text-sm font-medium rounded-lg transition duration-150 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand/20 active:scale-[0.98] ${FOCUS_RING}`}
        >
          保存
        </button>
      </div>
    </FieldBlock>
  )
}

// ── 路径 + 选择文件夹 + 保存 ──
export function PathField({ label, description, value, placeholder, onChange }: {
  label: string
  description: string
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  const [localValue, setLocalValue] = useState(value)
  const [dirty, setDirty] = useState(false)

  // Sync when the persisted value changes from outside (e.g. parent reload)
  useEffect(() => {
    setLocalValue(value)
    setDirty(false)
  }, [value])

  const handlePick = useCallback(() => {
    const api = (window as unknown as {
      __KHYOS__?: { openDirectoryPicker?: () => Promise<string> }
    }).__KHYOS__
    api?.openDirectoryPicker?.().then((dir) => {
      if (dir) {
        setLocalValue(dir)
        setDirty(dir !== value)
      }
    }).catch(() => {})
  }, [value])

  const handleSave = () => {
    // Data-path changes go through the migration IPC (copy data + write
    // pointer), not the plain settings:set — see main settings:setDataPath.
    const api = (window as unknown as {
      __KHYOS__?: { setDataPath?: (p: string) => Promise<{ ok: boolean; error?: string }> }
    }).__KHYOS__
    api?.setDataPath?.(localValue).then((res) => {
      if (res?.ok) {
        onChange(localValue)
        setDirty(false)
      } else {
        // Migration failed: keep dirty so the 保存 button stays retryable
        setDirty(true)
      }
    }).catch(() => {
      setDirty(true)
    })
  }

  return (
    <FieldBlock label={label} description={description}>
      <div className="flex gap-2">
        <input
          type="text"
          value={localValue}
          placeholder={placeholder}
          onChange={(e) => {
            setLocalValue(e.target.value)
            setDirty(e.target.value !== value)
          }}
          className={`${TEXT_INPUT} flex-1 ${FOCUS_RING}`}
        />
        <button onClick={handlePick} className={GHOST_BUTTON}>
          选择文件夹
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty}
          className={`bg-brand-subtle text-brand px-4 py-2 text-sm font-medium rounded-lg transition duration-150 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand/20 active:scale-[0.98] ${FOCUS_RING}`}
        >
          保存
        </button>
      </div>
    </FieldBlock>
  )
}

// ── 文本框（本地草稿 + 失焦提交）──
// Local draft + commit on blur: typing must not fire a settings write (and a
// host env push) on every keystroke.
export function TextField({ label, description, value, placeholder, onChange }: {
  label: string
  description: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <div className="py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-foreground-muted mt-1 leading-relaxed">{description}</div>
        </div>
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== value) onChange(draft) }}
          className={`${TEXT_INPUT} ${FOCUS_RING} min-w-[180px] flex-shrink-0`}
        />
      </div>
    </div>
  )
}