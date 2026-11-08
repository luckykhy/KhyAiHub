import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'

/**
 * 思维链折叠块（assistant 消息专用）。
 * 默认收起，整条头部是唯一切换入口；text 为空时整体不渲染。
 *
 * enabled 来自设置项 settings.showReasoning（缺省 true，即不传时一律显示）。
 * 单一真源在主进程 settings.json，经 App → MessageList → MessageBubble 下传，
 * Redux 里不放副本；关闭时本块整体不渲染（不是渲染成空壳）。
 *
 * 收起态不等于「什么都看不见」：流式中头部带转圈 + 最后一句实时尾巴，
 * 展开后内容逐字长出并贴底滚动。默认收起是用户拍板的阅读密度，不因加动效而改。
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
  const bodyRef = useRef<HTMLDivElement>(null)
  // 展开 + 流式时贴底：思考链每帧都在长，不贴底就永远停在第一段。
  useEffect(() => {
    if (!expanded || !isStreaming) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [expanded, isStreaming, text])

  const title = isStreaming ? t('chat.reasoning.thinking') : t('chat.reasoning.thought')
  // 收起来时给一行「最后在想什么」：整段不铺开，但用户能确认它确实在推进。
  const tail = isStreaming ? text.trim().split(/\r?\n/).filter(Boolean).pop() || '' : ''

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
        <span className="font-medium shrink-0">{title}</span>
        {isStreaming && <Spinner size="sm" className="shrink-0 text-trajectory-reasoning" />}
        {!expanded && tail && (
          <span className="min-w-0 flex-1 truncate text-xs font-normal text-foreground-muted">{tail}</span>
        )}
        <span className="text-xs text-foreground-muted ml-auto shrink-0">
          {expanded ? t('chat.message.collapse') : t('chat.message.expand')}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 animate-slide-down">
          <div
            ref={bodyRef}
            className="text-xs leading-relaxed text-foreground-muted whitespace-pre-wrap break-words max-h-60 overflow-auto"
          >
            {text}
            {isStreaming && <span className="khy-stream-caret" aria-hidden="true" />}
          </div>
        </div>
      )}
    </div>
  )
}
