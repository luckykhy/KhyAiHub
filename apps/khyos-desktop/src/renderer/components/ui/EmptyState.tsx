import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ icon = '□', title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
      <span className="text-4xl mb-4">{icon}</span>
      <h3 className="text-base font-medium text-foreground mb-2">{title}</h3>
      {description && (
        <p className="text-sm text-foreground/50 max-w-xs mb-4">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

// 单色线性图标（stroke 走 currentColor）——对齐 ZCode 首页快捷卡片样式：
// 紧凑 pill、细线图标、无 emoji、无副文本。
export interface QuickAction {
  id: string
  label: string
  icon: IconName
  // 有 prompt → 填入 composer；toAutomations → 跳自动化页
  prompt?: string
  toAutomations?: boolean
}

// ZCode 首页真源快捷动作（对齐首页 4 卡 + 代码审查/文档生成 两张补充卡）。
export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'report', icon: 'report', label: '周报总结', prompt: '总结本周工作进展：已完成 / 进行中 / 下周计划 / 风险与依赖，附关键数据与结论。' },
  { id: 'bugfix', icon: 'bug', label: '报错修复', prompt: '粘贴报错信息或日志，我来定位根因并给出最小修复：' },
  { id: 'ppt', icon: 'ppt', label: 'PPT 制作', prompt: '生成一份 PPT：主题 / 受众 / 页数 / 风格：' },
  { id: 'review', icon: 'review', label: '代码审查', prompt: '审查以下代码，按「正确性 / 可读性 / 性能 / 安全」分级列出问题与改进建议，附修复示例：' },
  { id: 'doc', icon: 'doc', label: '文档生成', prompt: '为以下内容生成文档（README / API / 使用指南），说明目标读者与侧重：' },
  { id: 'idle', icon: 'idle', label: '闲时任务', toAutomations: true },
]

export function ChatEmptyState({
  onQuickAction,
  composer,
  greeting,
  subtitle,
}: {
  onQuickAction?: (prompt: string) => void
  // 空态下 composer 嵌在问候语下方的居中卡片内（ZC-ALIGN-005 E3）；
  // 非空态传入 undefined，渲染器走底部固定 composer。
  composer?: ReactNode
  greeting?: string
  subtitle?: string
}) {
  const hour = new Date().getHours()
  const textGreeting =
    greeting ?? (
      hour < 6 ? '夜深啦，别忘了照顾好自己哦'
      : hour < 11 ? '早上好呀，新的一天开始啦'
      : hour < 13 ? '中午好呀，要不要先休息一下'
      : hour < 18 ? '下午好呀，接下来交给我吧'
      : '晚上好呀，今天辛苦啦'
    )
  const textSubtitle = subtitle ?? '有什么想让我帮忙的吗？我可以帮你编写代码、调试问题、重构项目。'
  const handleCard = (action: QuickAction) => {
    if (action.toAutomations) {
      window.location.hash = '#/automations'
      return
    }
    if (action.prompt && onQuickAction) {
      onQuickAction(action.prompt)
      return
    }
  }

  return (
    <div className="relative flex-1 overflow-auto">
      {/* ZCode 首页的大号水印 logo：右上角一个淡淡的斜杠形（纯装饰，pointer-events 关闭） */}
      <div className="pointer-events-none absolute right-8 top-10 text-[120px] leading-none text-foreground/[0.04] select-none font-sans">
        ／
      </div>

      <div className="flex flex-col items-center justify-center h-full min-h-full px-8 py-10 animate-fade-in">
        <h2 className="text-2xl font-medium text-foreground mb-2">{textGreeting}</h2>
        {textSubtitle && (
          <p className="text-sm text-foreground/50 max-w-sm mb-5 text-center">{textSubtitle}</p>
        )}

        {/* 输入卡片 — 居中，宽度对齐 ZCode 实测 (~560px)，卡片内含 composer */}
        {composer && (
          <div className="w-full max-w-[560px] mb-4">{composer}</div>
        )}

        {/* 快捷动作 — 紧凑 pill 行，单色线性图标，无副文本（ZC-ALIGN-005 E3） */}
        <div className="flex flex-wrap justify-center gap-2">
          {QUICK_ACTIONS.map(item => (
            <button
              key={item.id}
              onClick={() => handleCard(item)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-card/60 text-xs text-foreground/80 hover:bg-surface-hover hover:text-foreground transition-colors"
            >
              <span className="text-foreground/60"><Icon name={item.icon} size={14} /></span>
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
