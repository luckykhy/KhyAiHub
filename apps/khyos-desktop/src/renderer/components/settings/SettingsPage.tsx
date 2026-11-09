// khy-canary: Khy-20261102-315-SY2FKXXC
import { useState, useEffect, useCallback } from 'react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { McpSettings } from './McpSettings'
import { BrowserSettings, CuaSettings } from './BrowserCuaSettings'
import { UsageSettings } from './UsageSettings'
import { OnboardingSettings } from './OnboardingSettings'
import { OnboardingDialog } from './OnboardingDialog'
import { ListSettingsPage } from './ListSettingsPage'
import { IndexSettingsPage } from './IndexSettingsPage'
import { PluginSettings } from './PluginSettings'
import { KeyManagerPage } from '../keyManager/KeyManagerPage'
import { WebRemoteControlPanel } from '../remote/WebRemoteControlPanel'
import { Icon } from '../ui/Icon'
import { SettingsNavIcon, type SettingsNavIconId } from './SettingsNavIcon'
import { invalidateCodeDisplaySettings } from '../message/useCodeDisplaySettings'
import { useChatIdentity } from '../../shared/chatIdentity'
import { useAccountAvatar } from '../../shared/accountAvatar'

// ── Nav structure (mirrors ZCode v3.11.2 a11y s-30/s-42, ZC-ALIGN-003 §1-4) ──
// Full-screen replacement layout: left nav (~240px) + right content scroll area.
// Three groups + standalone 引导 + 返回工作区 at top + account row at bottom.

interface NavItem {
  id: SettingsNavIconId
  label: string
}
interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'basic',
    label: '基础设置',
    items: [
      { id: 'general', label: '常规' },
      { id: 'appearance', label: '外观' },
      { id: 'models', label: '模型设置' },
      { id: 'browser', label: '浏览器控制' },
      { id: 'cua', label: '电脑控制' },
      { id: 'remote', label: '移动端远程控制' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 能力',
    items: [
      { id: 'memory', label: '记忆' },
      { id: 'subagents', label: '子智能体' },
      { id: 'plugins', label: '插件' },
      { id: 'mcp', label: 'MCP 服务器' },
      { id: 'skills', label: '技能' },
      { id: 'commands', label: '命令' },
      { id: 'hooks', label: '钩子' },
    ],
  },
  {
    id: 'data',
    label: '数据与统计',
    items: [
      { id: 'index', label: '索引库' },
      { id: 'usage', label: '使用统计' },
    ],
  },
]

// Page metadata: title + subtitle for the right pane header (from a11y s-30)
const PAGE_META: Record<string, { title: string; subtitle?: string }> = {
  general: { title: '常规' },
  appearance: { title: '外观' },
  models: { title: '模型设置', subtitle: '管理自定义模型供应商，配置后可在聊天时选择使用。' },
  browser: { title: '浏览器控制', subtitle: '配置内置浏览器的行为与安全策略。' },
  cua: { title: '电脑控制', subtitle: '配置 Agent 操作电脑的权限与安全边界。' },
  remote: { title: '移动端远程控制', subtitle: '扫码或在手机上打开链接，远程控制当前工作区。' },
  memory: { title: '记忆', subtitle: '与终端共用同一份记忆库，存储跨会话的上下文信息。' },
  subagents: { title: '子智能体', subtitle: '管理可委派的子智能体。' },
  plugins: { title: '插件', subtitle: '启用或停用已安装的插件。插件可打包技能、命令、Hooks 和 MCP 服务器。' },
  mcp: { title: 'MCP 服务器', subtitle: '管理 MCP 服务器，配置后可在对话中使用其工具。' },
  skills: { title: '技能', subtitle: '管理 Agent 技能，扩展其能力范围。' },
  commands: { title: '命令', subtitle: '与终端同一批命令：Khy 内置命令只读展示，自定义命令配置后可用 / 触发。' },
  hooks: { title: '钩子', subtitle: '配置 Agent 生命周期事件的处理逻辑。' },
  index: { title: '索引库', subtitle: '管理代码索引库，用于增强 Agent 的代码理解能力。' },
  usage: { title: '使用统计', subtitle: '查看模型用量与 Token 消耗趋势。' },
  onboarding: { title: '引导' },
}

export function SettingsPage() {
  // Deep-link support: #/settings/plugins → start on the 插件 page.
  const [activePage, setActivePage] = useState(() => {
    const suffix = window.location.hash.replace(/^#\/settings\/?/, '')
    return PAGE_META[suffix] ? suffix : 'general'
  })
  // 账号名真源是 settings.desktopAccountName（见 shared/chatIdentity）。
  // 旧实现把中性名「本地用户」写死两次（这里与侧栏），改名后两处都跟不上。
  const { userName: accountName } = useChatIdentity()
  const accountAvatar = useAccountAvatar()
  const [settings, setSettings] = useState<Record<string, unknown>>({})

  // Load persisted settings on mount (preload IPC: settings:get)
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
    }).__KHYOS__
    api?.getSettings?.().then((s) => setSettings(s || {})).catch(() => {})
  }, [])

  // Persist a single setting key (preload IPC: settings:set)
  const updateSetting = useCallback((key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    const api = (window as unknown as {
      __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<void> }
    }).__KHYOS__
    api?.setSetting?.(key, value).then(() => {
      // 落盘完成后再通知消费方重读：「语法高亮 / 行号显示」两个开关的渲染层
      // 消费方在 message 区域（模块级缓存），写完立即 invalidate 才不用重开应用。
      invalidateCodeDisplaySettings()
    }).catch(() => {})
  }, [])

  const handleBack = () => {
    window.location.hash = ''
  }

  const meta = PAGE_META[activePage] || { title: activePage }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* OnboardingDialog: mounted once, opens on khy:open-onboarding (D5/s-8).
          打开引导 rows on 常规/引导 pages dispatch that event. */}
      <OnboardingDialog />
      {/* Top bar: ZCode logo + window menu + caption (caption buttons are in TitleBar overlay) */}
      <div className="flex items-center justify-between h-[60px] px-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">KhyOS</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleBack}
            className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
          >
            返回工作区
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left navigation ── */}
        {/* 窄窗（<1000px）整栏收成 64px，只留自绘标记：条目文字与分组标题隐藏，
            组间改由细分隔线断开；64px 下按钮宽 48px，刚好容 16px 标记居中。 */}
        <nav className="w-[240px] flex-shrink-0 border-r border-border flex flex-col overflow-hidden max-[1000px]:w-[64px]">
          {/* Top: 返回工作区 */}
          <div className="p-3 border-b border-border max-[1000px]:p-2!">
            <button
              onClick={handleBack}
              title="返回工作区"
              aria-label="返回工作区"
              className="w-full px-3 py-2 text-sm text-left text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors duration-150 flex items-center gap-2 max-[1000px]:justify-center max-[1000px]:px-0!"
            >
              <Icon name="chevron-left" size={14} />
              <span className="max-[1000px]:hidden">返回工作区</span>
            </button>
          </div>

          {/* Nav groups (scrollable) */}
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {NAV_GROUPS.map((group, groupIndex) => (
              <div key={group.id} className="mb-3">
                <div className="px-3 py-1.5 text-xs font-medium text-foreground max-[1000px]:hidden">
                  {group.label}
                </div>
                {groupIndex > 0 && (
                  <div
                    aria-hidden="true"
                    className="mx-1 my-2 hidden border-t border-border/60 max-[1000px]:block"
                  />
                )}
                {group.items.map((item) => (
                  <NavButton
                    key={item.id}
                    icon={item.id}
                    label={item.label}
                    active={activePage === item.id}
                    onClick={() => setActivePage(item.id)}
                  />
                ))}
              </div>
            ))}

            {/* Standalone: 引导 (no group header — ZCode a11y s-25 has none) */}
            <NavButton
              icon="onboarding"
              label="引导"
              active={activePage === 'onboarding'}
              onClick={() => setActivePage('onboarding')}
            />
          </div>

          {/* Bottom: account chip + 返回工作区 */}
          <div className="border-t border-border p-3 flex items-center gap-2 max-[1000px]:justify-center max-[1000px]:p-2!">
            {/* bg-brand/20 在浅色主题下 brand 为纯黑，圈与字都读成黑；改用
                brand-subtle（低透明品牌面）+ text-brand，浅色下是蓝圈蓝字。
                默认头像就是桌宠立绘（暗底图），底色留着当加载垫。 */}
            <div
              className="w-7 h-7 rounded-full bg-brand-subtle flex items-center justify-center text-xs font-semibold text-brand flex-shrink-0 overflow-hidden"
              title={accountName}
            >
              {accountAvatar.dataUrl ? (
                <img src={accountAvatar.dataUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                // 与侧栏同一套取景：默认立绘放大 1.4 倍，自选头像不缩放。
                <img src={accountAvatar.defaultUrl} alt="" className="w-full h-full object-cover scale-[1.4]" />
              )}
            </div>
            <span className="text-sm font-medium text-foreground truncate flex-1 max-[1000px]:hidden">{accountName}</span>
            <button
              onClick={handleBack}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors duration-150 flex-shrink-0 max-[1000px]:hidden!"
              title="返回工作区"
              aria-label="返回工作区"
            >
              <Icon name="chevron-left" size={14} />
            </button>
          </div>
        </nav>

        {/* ── Right content area ── */}
        <main className="flex-1 overflow-y-auto">
          {/* Page header — centered column so content doesn't hug the left nav */}
          <div className={`px-8 pt-8 pb-2 mx-auto w-full ${activePage === 'models' ? 'max-w-5xl' : 'max-w-3xl'}`}>
            <h1 className="text-xl font-semibold text-foreground">{meta.title}</h1>
            {meta.subtitle && (
              <p className="text-sm text-foreground-muted mt-1">{meta.subtitle}</p>
            )}
          </div>

          {/* Page content — models 页放宽容器（DESIGN-ARCH-150 §3.1） */}
          <div className={`px-8 pb-16 mx-auto w-full ${activePage === 'models' ? 'max-w-5xl' : 'max-w-3xl'}`}>
            {activePage === 'general' && (
              <GeneralSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'appearance' && (
              <AppearanceSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'models' && (
              <div className="border border-card-border rounded-xl overflow-hidden">
                <KeyManagerPage embedded />
              </div>
            )}
            {activePage === 'browser' && (
              <BrowserSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'cua' && (
              <CuaSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'remote' && <WebRemoteControlPanel />}
            {activePage === 'mcp' && <McpSettings />}
            {activePage === 'usage' && <UsageSettings />}
            {activePage === 'onboarding' && (
              <OnboardingSettings settings={settings} onChange={updateSetting} />
            )}
            {/* Pattern B: list pages backed by agentItemStore (P13 real wiring) */}
            {activePage === 'commands' && (
              <ListSettingsPage
                kind="command"
                noun="命令"
                description="与终端同一批命令：下方同时列出 Khy 终端内置命令（只读，含在输入框敲 / 的执行方式）与本机自定义命令（.claude/commands）；自定义命令新建后终端以 / 前缀调用。"
                contentLabel="命令内容"
                contentPlaceholder="/ 前缀触发的提示词，支持 $ARGUMENTS 占位符"
              />
            )}
            {activePage === 'hooks' && (
              <ListSettingsPage
                kind="hook"
                noun="钩子"
                description="与终端共用 hooks.json：这里启停的钩子在终端立即生效。"
                contentLabel="钩子脚本"
                contentPlaceholder="事件名 + 处理命令，例如 PreToolUse: node check.js"
              />
            )}
            {activePage === 'skills' && (
              <ListSettingsPage
                kind="skill"
                noun="技能"
                description="与终端共用技能目录（内置 / 项目 / 用户）。"
                contentLabel="技能说明"
                contentPlaceholder="技能的指令内容，保存为技能目录下的 prompt.md"
              />
            )}
            {activePage === 'subagents' && (
              <ListSettingsPage
                kind="subagent"
                noun="子智能体"
                description="与终端共用子智能体目录，内置项只读。"
                contentLabel="配置"
                contentPlaceholder="子智能体的职责描述与提示词"
              />
            )}
            {activePage === 'plugins' && <PluginSettings />}
            {activePage === 'memory' && (
              <ListSettingsPage
                kind="memory"
                noun="记忆"
                description="与终端共用记忆库：这里新增或删除的记忆，终端开新会话时立即可见。"
                contentLabel="记忆内容"
                contentPlaceholder="希望 Agent 跨会话记住的信息"
                installedLabel="记忆库"
                emptyLabel="记忆库为空"
              />
            )}
            {activePage === 'index' && <IndexSettingsPage />}
          </div>
        </main>
      </div>
    </div>
  )
}

// ── Nav button (matches ZCode left nav item style) ──
// 宽度交给父容器的 px-2 + 本项的 w-full：此前写法是 w-full + mx-1 再用内联
// style width:calc(100% - 8px) 覆盖，w-full 被内联样式吃掉成为死类，且组标题
// (px-4) 与条目文字 (mx-1 + px-4) 差 4px，同组标题和条目左缘不齐。
// 激活态：灰底(bg-selected)之上叠一根品牌色指示条——仅靠灰块时当前页定位感
// 偏弱，指示条随 --color-brand 变蓝后在暗/浅两套主题都能定位（§5.4）。
function NavButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: SettingsNavIconId
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`relative w-full px-3 py-2 text-sm text-left transition-colors duration-150 rounded-lg flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar max-[1000px]:justify-center max-[1000px]:px-0! ${
        active
          ? 'bg-selected text-foreground font-medium'
          : 'text-foreground/70 hover:text-foreground hover:bg-surface-hover'
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-brand max-[1000px]:hidden"
        />
      )}
      {/* 收窄后没有文字兜底，激活态改由品牌色标记本身提示。 */}
      <SettingsNavIcon
        name={icon}
        size={16}
        className={`flex-shrink-0 ${active ? 'max-[1000px]:text-brand' : ''}`}
      />
      <span className="truncate max-[1000px]:hidden">{label}</span>
    </button>
  )
}

