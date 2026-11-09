// khy-canary: Khy-20261102-316-NV7K2QPD
// 设置页侧栏的 16 枚自绘标记。侧栏收窄到只剩标记时，文字全部消失，
// 每枚字形必须彼此可分辨——故不复用 ui/Icon 的 lucide 字形（其中
// 设置/自动化等在 14px 下已出现过撞脸），按条目语义单独画。
//
// 网格 24、描边 1.6、currentColor、fill none：与 ui/Icon 的描边口径对齐，
// 深浅主题随文字色走。实心点用 fill=currentColor + stroke=none 压到 1px 级。
import type { ReactNode } from 'react'

export type SettingsNavIconId =
  | 'general'
  | 'appearance'
  | 'models'
  | 'browser'
  | 'cua'
  | 'remote'
  | 'memory'
  | 'subagents'
  | 'plugins'
  | 'mcp'
  | 'skills'
  | 'commands'
  | 'hooks'
  | 'index'
  | 'usage'
  | 'onboarding'

const STROKE = 1.6

const GLYPHS: Record<SettingsNavIconId, ReactNode> = {
  // 常规：三条滑杆，三个旋钮错位，读作「可调的偏好项」。
  general: (
    <>
      <path d="M3.5 7h5.6M13.4 7h7.1" />
      <circle cx="11.5" cy="7" r="2.1" />
      <path d="M3.5 12h10M18.1 12h2.4" />
      <circle cx="16.1" cy="12" r="2.1" />
      <path d="M3.5 17h4.4M12.1 17h8.4" />
      <circle cx="10.1" cy="17" r="2.1" />
    </>
  ),
  // 外观：圆只填右半边，明暗主题一眼可读。
  appearance: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  // 模型设置：芯片本体 + 中央核心 + 八根引脚。
  models: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
      <rect x="10" y="10" width="4" height="4" rx="1" />
      <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
    </>
  ),
  // 浏览器控制：窗口 + 地址栏；左上三颗实心点表示窗口按钮。
  browser: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M3 9.2h18" />
      <circle cx="6.1" cy="6.8" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="8.8" cy="6.8" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="11.5" cy="6.8" r="0.85" fill="currentColor" stroke="none" />
    </>
  ),
  // 电脑控制：显示器 + 底座，屏幕里是鼠标指针。
  cua: (
    <>
      <rect x="3" y="4.4" width="18" height="11.6" rx="2" />
      <path d="M12 16v3M8.4 19h7.2" />
      <path d="M9.6 7.8l5.9 2.3-2.5 1.1-1.1 2.5z" />
    </>
  ),
  // 移动端远程控制：手机 + 屏内信号弧。
  remote: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.4" />
      <path d="M9.7 10.6a3.5 3.5 0 0 1 4.6 0M10.9 12.2a1.8 1.8 0 0 1 2.2 0" />
      <circle cx="12" cy="13.9" r="0.9" fill="currentColor" stroke="none" />
      <path d="M10.5 17.8h3" />
    </>
  ),
  // 记忆：中心节点连三条分支，读作跨会话的关联记忆。
  memory: (
    <>
      <circle cx="12" cy="12" r="3.4" />
      <circle cx="12" cy="5.2" r="1.6" />
      <circle cx="5.6" cy="16.6" r="1.6" />
      <circle cx="18.4" cy="16.6" r="1.6" />
      <path d="M12 8.6V6.8M9.4 13.7l-2.3 1.6M14.6 13.7l2.3 1.6" />
    </>
  ),
  // 子智能体：根节点向下分派到两个子节点。
  subagents: (
    <>
      <circle cx="12" cy="6" r="2.2" />
      <circle cx="6.5" cy="17.6" r="2.2" />
      <circle cx="17.5" cy="17.6" r="2.2" />
      <path d="M10.9 7.9l-3 7.8M13.1 7.9l3 7.8" />
    </>
  ),
  // 插件：顶部凸起、右侧外凸的拼块。
  plugins: (
    <path d="M4.5 7.5h5.3V6.1a2.15 2.15 0 0 1 4.3 0v1.4h5.4v2.7a2.2 2.2 0 0 1 0 4.4v4.9H4.5z" />
  ),
  // MCP 服务器：两层机架，各带状态点与槽位线。
  mcp: (
    <>
      <rect x="3.8" y="4" width="16.4" height="6.2" rx="1.8" />
      <rect x="3.8" y="13.8" width="16.4" height="6.2" rx="1.8" />
      <circle cx="7.3" cy="7.1" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7.3" cy="16.9" r="0.9" fill="currentColor" stroke="none" />
      <path d="M13 7.1h3.9M13 16.9h3.9" />
    </>
  ),
  // 技能：主星芒 + 右下小星芒，读作「可装载的能力包」。
  skills: (
    <>
      <path d="M11 3.4c.6 3.5 2.1 5 5.6 5.6-3.5.6-5 2.1-5.6 5.6-.6-3.5-2.1-5-5.6-5.6 3.5-.6 5-2.1 5.6-5.6z" />
      <path d="M17.6 15.4c.3 1.5.9 2.1 2.4 2.4-1.5.3-2.1.9-2.4 2.4-.3-1.5-.9-2.1-2.4-2.4 1.5-.3 2.1-.9 2.4-2.4z" />
    </>
  ),
  // 命令：终端窗口 + 提示符。
  commands: (
    <>
      <rect x="3.2" y="4.5" width="17.6" height="15" rx="2.4" />
      <path d="M7 9.2l2.6 2.8L7 14.8M12.2 15.1h4.3" />
    </>
  ),
  // 钩子：带倒刺的弯钩，和「命令」的方框刻意错开。
  hooks: (
    <>
      <circle cx="15.6" cy="5.8" r="1.7" />
      <path d="M15.6 7.5v4.9a4.2 4.2 0 0 1-8.4 0v-1.6" />
      <path d="M5.6 8.6l1.6 2.2 1.9-2" />
    </>
  ),
  // 索引库：放大镜里是两行条目。
  index: (
    <>
      <circle cx="10.4" cy="10.4" r="5.7" />
      <path d="M14.6 14.6 20 20" />
      <path d="M8 8.7h4.9M8 11.3h3.3" />
    </>
  ),
  // 使用统计：三根等高递进的柱。
  usage: (
    <>
      <rect x="5" y="12.4" width="3.6" height="5.8" rx="1" />
      <rect x="10.2" y="8.4" width="3.6" height="9.8" rx="1" />
      <rect x="15.4" y="5.2" width="3.6" height="13" rx="1" />
    </>
  ),
  // 引导：罗盘。
  onboarding: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M14.9 9.1l-1.7 4.1-4.1 1.7 1.7-4.1z" />
    </>
  ),
}

export function SettingsNavIcon({
  name,
  size = 16,
  className,
}: {
  name: SettingsNavIconId
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  )
}
