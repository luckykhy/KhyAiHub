// khy-canary: Khy-20261102-313-3ZF1991S
// ── 引导 settings page (ZC-ALIGN-003 §1, a11y s-30 引导 section) ──
// Pattern D: minimal content + dialog trigger.
// Two items: 优化体验 toggle + 打开引导 button (reopens onboarding modal).
// 字段组件统一来自 ./fields.tsx（本页不再自带副本）。
import { SettingSection, ToggleField, ActionField } from './fields'

interface OnboardingSettingsProps {
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

export function OnboardingSettings({ settings, onChange }: OnboardingSettingsProps) {
  return (
    <div className="max-w-3xl">
      <SettingSection title="引导">
        <ToggleField
          label="优化体验"
          description="允许我们将你的对话内容用于优化 Agent 的使用体验。我们保障你的数据隐私安全。"
          enabled={settings.optInExperience === true}
          onChange={(v) => onChange('optInExperience', v)}
        />
        <ActionField
          label="打开引导"
          description="重新打开引导弹窗，查看迁移选项并导入设置。"
          buttonText="打开引导"
          onClick={() => {
            // OnboardingDialog listens on the window event (same pattern as
            // khy:open-command-center), mounted once by SettingsPage.
            window.dispatchEvent(new Event('khy:open-onboarding'))
          }}
        />
      </SettingSection>
    </div>
  )
}
