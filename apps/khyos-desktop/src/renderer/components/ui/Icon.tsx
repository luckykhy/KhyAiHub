// 全局图标注册表 —— 桌面端 UI 图标从这一处出口（侧栏导航、账户区、首页快捷卡片）。
//
// 本套字形是 2026-10-02 用户点名重做的，**有意偏离 ZCode 1:1 复刻**（CLAUDE.md 的
// 复刻口径管布局/结构/交互，美术资产本就要求自研）：原版「设置」与「自动化」
// 同为圆+射线，14px 下无法区分，故整组换形。
//
// 底稿取自仓内既有依赖 lucide-react（ISC；smartphone/search 衍生自 Feather Icons，MIT）。
// 两枚定制字形（automation / remote-mobile）在 lucide 24 网格上缩放叠加元素。
//
// 描边统一 1.6：lucide 默认 2 在 14–15px 下发糊，原手绘件的 1.2 又太细。
// 颜色一律 currentColor，深浅主题随文字色自动走。
import {
  Bug,
  ChartColumn,
  CodeXml,
  FileText,
  MoonStar,
  Presentation,
  Puzzle,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react'

const STROKE = 1.6

export type IconName =
  // 侧栏顶部导航
  | 'new-task'
  | 'search'
  | 'automation'
  | 'plugins'
  // 账户区
  | 'remote-mobile'
  | 'settings'
  // 首页快捷卡片
  | 'report'
  | 'bug'
  | 'ppt'
  | 'review'
  | 'doc'
  | 'idle'

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

// 自动化 = 闪电 + 留缺口圆环。环口在右上（缺口暗示"循环触发"，也避免与
// lucide 齿轮的封闭轮廓撞形）；闪电按 s 缩进环内，描边除以 s 补偿回 1.6。
function AutomationGlyph({ size, className }: { size: number; className?: string }) {
  const s = 0.64
  const off = (24 - 24 * s) / 2
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
      <path d="M13.8 1.7A10.5 10.5 0 1 0 21.9 8.4" />
      <g transform={`translate(${off} ${off}) scale(${s})`} strokeWidth={STROKE / s}>
        <path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z" />
      </g>
    </svg>
  )
}

// 移动端远程 = 手机机身（lucide Smartphone 比例，缩至左侧）+ 右上两道无线波纹。
// 原 6×11 小矩形在 14px 下读不出手机，波纹补的是"远程"这层语义。
function RemoteMobileGlyph({ size, className }: { size: number; className?: string }) {
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
      <rect x="4.1" y="3.4" width="10.1" height="14.4" rx="1.4" />
      <path d="M9.1 15h.01" />
      <path d="M17.7 7A2.5 2.5 0 0 0 15.2 4.5" />
      <path d="M20.2 7A5 5 0 0 0 15.2 2" />
    </svg>
  )
}

export function Icon({ name, size = 15, className }: IconProps) {
  switch (name) {
    case 'new-task':
      return <SquarePen size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'search':
      return <Search size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'automation':
      return <AutomationGlyph size={size} className={className} />
    case 'plugins':
      return <Puzzle size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'remote-mobile':
      return <RemoteMobileGlyph size={size} className={className} />
    case 'settings':
      return <Settings size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'report':
      return <ChartColumn size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'bug':
      return <Bug size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'ppt':
      return <Presentation size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'review':
      return <CodeXml size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'doc':
      return <FileText size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
    case 'idle':
      return <MoonStar size={size} strokeWidth={STROKE} className={className} aria-hidden="true" />
  }
}
