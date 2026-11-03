import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../ui/Icon'

/**
 * 思维链折叠块（assistant 消息专用）。
 * 默认收起，整条头部是唯一切换入口；text 为空时整体不渲染。
 *
 * enabled 来自设置项 settings.showReasoning（缺省 true，即不传时一律显示）。
 * 单一真源在主进程 settings.json，经 App → MessageList → MessageBubble 下传，
 * Redux 里不放副本；关闭时本块整体不渲染（不是渲染成空壳）。
 */
export function ThinkingBlock({
  text,
  isStreaming = false,
  enabled = true,
}: {
  text: string
  isStreaming?: boolean
  enabled?: boolean
}) {
  // 空思维链不渲染空壳；settings.showReasoning 关闭时同样不渲染
  if (!text || enabled === false) return null

  const { t } = useTranslation()
  // 默认收起 —— 用户要的「收取」态
  const [expanded, setExpanded] = useState(false)
  const title = isStreaming ? t('chat.reasoning.thinking') : t('chat.reasoning.thought')

  return (
    <div className="mb-3 rounded-xl border border-border border-l-2 border-l-trajectory-reasoning bg-reasoning-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        data-testid="chat-reasoning-trigger"
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
      >
        <span className={`transition-transform duration-200 text-xs ${expanded ? 'rotate-90' : ''}`}>
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="font-medium">{title}</span>
        <span className="text-xs text-foreground-muted ml-auto">
          {expanded ? t('chat.message.collapse') : t('chat.message.expand')}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 animate-slide-down">
          <div className="text-xs leading-relaxed text-foreground-muted whitespace-pre-wrap break-words max-h-60 overflow-auto">
            {text}
          </div>
        </div>
      )}
    </div>
  )
}
