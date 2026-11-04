// khy-canary: Khy-20261102-299-VS1CK7JM
import { lazy, Suspense, useState } from 'react'
import type { ReactNode } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ThinkingBlock } from './ThinkingBlock'
import { ChatEmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { SkeletonBubble } from '../ui/Skeleton'
import { useAppDispatch, useAppSelector } from '../../state/store'
import { requestRetry, selectMessageReasoning } from '../../state/messageSlice'
import type { Message as StoreMessage } from '../../state/messageSlice'
import {
  useSessionLoadSignal,
  useSessionLoadError,
  useMessagesSessionId,
  resolveMessageAreaView,
  shouldKeepMessagesOnFailure,
  describeSessionLoadError,
} from './sessionLoad'

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  result?: string
}

// 工具执行块按归属消息渲染在消息内部：它是本轮提问的过程证据，不能做成
// 挂在消息列表上方的全局块 —— 那样它既不在对应提问下面，切换会话后还会
// 跟着显示。仍走动态 import：没有工具执行的消息不渲染它。
const ToolExecutionPanel = lazy(() =>
  import('./ToolExecutionPanel').then((m) => ({ default: m.ToolExecutionPanel }))
)

interface TrajectoryStep {
  type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  timestamp: number
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  trajectory?: TrajectoryStep[]
  toolCalls?: ToolCall[]
  isStreaming?: boolean
  failed?: boolean
  /** 思维链全文（assistant 消息）；空 = 不渲染折叠块。 */
  reasoning?: string
  /** 思维链折叠块是否显示（settings.showReasoning；缺省 true = 显示）。 */
  showReasoning?: boolean
  error?: string
}

// 网关把失败包装成 success:true 的正文（如 CLI 桥接返回 "API Error: ..."），
// 只能按内容特征识别。按规则 2.2 把原始错误映射成「问题 + 识别码 + 修复建议」，
// 原文保留在详情里不丢失诊断信息。
const ERROR_PATTERNS: { re: RegExp; title: string; hint: string }[] = [
  { re: /401|incorrect api key|unauthorized|invalid[_ ]api[_ ]key|authentication/i, title: '认证失败 (401)：API key 无效或过期', hint: '请在设置中更新密钥，或运行 khy gateway config' },
  { re: /403|permission|forbidden/i, title: '权限不足 (403)：无权访问该模型', hint: '请检查订阅或更换密钥' },
  { re: /\b404\b|not found/i, title: '接口不存在 (404)：通道端点配置可能有误', hint: '请运行 khy gateway status 检查通道配置' },
  { re: /429|rate.?limit|quota/i, title: '限流 (429)：请求过多或额度不足', hint: '请稍后重试，或运行 khy gateway config 切换通道' },
  { re: /econnrefused|connection refused|econnreset|enotfound|network|socket/i, title: '网络连接失败：模型通道不可达', hint: '请检查网络与代理设置，或运行 khy gateway status' },
  { re: /timeout|etimedout|aborted/i, title: '请求超时：网络或服务响应慢', hint: '请稍后重试，或更换模型通道' },
  { re: /\b5\d{2}\b|internal server error|bad gateway|service unavailable/i, title: '上游异常 (5xx)：模型服务暂不可用', hint: '请稍后重试，或运行 khy gateway status 切换通道' },
]

function describeGatewayError(content: string): { title: string; hint: string } | null {
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(content)) return { title: p.title, hint: p.hint }
  }
  return null
}

// 错误卡片：AI 请求失败时替代普通正文渲染。红边卡片 + 映射后的中文诊断 +
// 原始错误详情 + 重试按钮（用出错前的 prompt 原文重发，经全局 retry 信号）。
function ErrorCard({ message }: { message: Message }) {
  const dispatch = useAppDispatch()
  const lastPrompt = useAppSelector((s: { message: { lastPrompt: string } }) => s.message.lastPrompt)
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const raw = message.error || message.content
  const mapped = describeGatewayError(raw)
  const title = mapped ? mapped.title : 'AI 请求失败'
  const hint = mapped ? mapped.hint : '请重试，或运行 khy gateway status 检查通道健康'

  const canRetry = Boolean(lastPrompt)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-xl border border-destructive/40 bg-destructive/5 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start gap-2">
          <Icon name="warning" size={14} className="text-destructive mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-destructive">{title}</div>
            <div className="text-sm text-foreground/70 mt-1 leading-relaxed">{hint}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          {canRetry && (
            <button
              onClick={() => dispatch(requestRetry(lastPrompt))}
              className="px-3 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors inline-flex items-center gap-1.5"
              title="用出错前的提问重新发送"
            >
              <Icon name="rotate-ccw" size={12} />
              <span>重试</span>
            </button>
          )}
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors inline-flex items-center gap-1.5"
          >
            {copied && <Icon name="check" size={12} />}
            <span>{copied ? '已复制' : '复制错误信息'}</span>
          </button>
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="px-3 py-1.5 rounded-lg text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {showRaw ? '收起详情' : '查看详情'}
          </button>
        </div>
        {showRaw && (
          <pre className="mt-2 px-3 py-2 rounded-lg bg-input text-xs font-mono text-foreground-muted whitespace-pre-wrap break-all max-h-40 overflow-auto animate-slide-down">
            {raw}
          </pre>
        )}
      </div>
    </div>
  )
}

function TrajectoryTimeline({ steps }: { steps: TrajectoryStep[] }) {
  const [expanded, setExpanded] = useState(false)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)

  // 只有颜色与文案被渲染消费，图标字段是死配置（不保留装饰字符）
  const typeConfig = {
    user: { color: 'var(--color-trajectory-user)', label: '用户' },
    assistant: { color: 'var(--color-trajectory-assistant)', label: '助手' },
    reasoning: { color: 'var(--color-trajectory-reasoning)', label: '思考' },
    'tool-call': { color: 'var(--color-trajectory-tool-call)', label: '工具调用' },
    'tool-result': { color: 'var(--color-trajectory-tool-result)', label: '工具结果' },
  }

  return (
    <div className="mb-3 bg-surface rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover transition-colors"
      >
        <span className={`transition-transform duration-200 text-xs ${expanded ? 'rotate-90' : ''}`}>
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="font-medium">思考轨迹</span>
        <span className="text-foreground-muted mx-1">·</span>
        <span className="text-xs text-foreground-muted">{steps.length} 步</span>
        <span className="text-xs text-foreground-muted ml-auto">{expanded ? '收起' : '展开'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1 animate-slide-down">
          {steps.map((step, index) => {
            const config = typeConfig[step.type]
            return (
              <div
                key={index}
                onClick={() => setSelectedStep(selectedStep === index ? null : index)}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-colors ${
                  selectedStep === index ? 'bg-surface-hover' : 'hover:bg-surface-hover/50'
                }`}
              >
                <div
                  className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                  style={{ backgroundColor: config.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold" style={{ color: config.color }}>
                      {config.label}
                    </span>
                    <span className="text-xs text-foreground-muted">
                      {new Date(step.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-sm text-foreground/80 mt-1 leading-relaxed">
                    {step.content}
                  </div>
                  {selectedStep === index && step.toolName && (
                    <div className="mt-2 p-3 bg-card rounded-lg border border-card-border text-xs font-mono text-foreground-muted animate-fade-in">
                      <div className="text-foreground-muted mb-1 font-sans font-medium">Tool: {step.toolName}</div>
                      {step.toolInput && (
                        <pre className="whitespace-pre-wrap break-all leading-relaxed">
                          {JSON.stringify(step.toolInput, null, 2)}
                        </pre>
                      )}
                      {step.toolResult && (
                        <div className="mt-2 pt-2 border-t border-card-border">
                          <div className="text-foreground-muted mb-1 font-sans font-medium">Result:</div>
                          <pre className="whitespace-pre-wrap break-all leading-relaxed">{step.toolResult}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false)

  // icon 字段此前无消费方（渲染只用 color/bg/label），已随装饰字符一并删除
  const statusConfig = {
    pending: { color: 'text-foreground-muted', bg: 'bg-foreground/20', label: '等待中' },
    running: { color: 'text-warning', bg: 'bg-warning/20', label: '运行中' },
    success: { color: 'text-success', bg: 'bg-success/20', label: '完成' },
    error: { color: 'text-destructive', bg: 'bg-destructive/20', label: '失败' },
  }

  const status = statusConfig[tool.status]

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`w-2.5 h-2.5 rounded-full ${status.bg} ${status.color} ${tool.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="font-medium text-foreground flex-1 text-left">{tool.name}</span>
        <span className={`text-xs font-medium ${status.color}`}>{status.label}</span>
        <span className={`text-foreground-subtle transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 animate-slide-down">
          <div className="text-xs font-mono text-foreground-muted bg-input rounded-lg p-3 mb-2 max-h-32 overflow-auto">
            <pre className="whitespace-pre-wrap break-all leading-relaxed">{JSON.stringify(tool.input, null, 2)}</pre>
          </div>
          {tool.result && (
            <div className="text-xs font-mono text-foreground/70 bg-input rounded-lg p-3 max-h-32 overflow-auto">
              <pre className="whitespace-pre-wrap break-all leading-relaxed">{tool.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  // 只订阅「本条消息有没有工具执行」这个布尔量：若直接订阅 executions 数组，
  // 任何一条消息的工具事件都会让整串消息重渲染。
  const hasToolExecutions = useAppSelector((s) =>
    s.toolExecution.executions.some((e) => e.messageId === message.id)
  )

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isUser = message.role === 'user'

  return (
    // 消息流去表格化：此前每条消息一条通栏分隔线（border-b），读感像表格行
    // 而非对话。改为靠 py-4 的垂直间距分隔，层级由间距与用户轮的底板承担。
    <div className="group px-5 py-4 animate-fade-in">
      {/* 头部 — 始终可见（内嵌终端形态：头像圆圈换终端提示符，统一左对齐
          提示符布局，不再保留聊天式的用户行右对齐；收起/复制按钮保留） */}
      <div className="flex items-center gap-3 mb-3">
        <span
          className={`font-mono text-sm leading-none select-none ${
            isUser ? 'text-trajectory-user' : 'text-trajectory-assistant'
          }`}
        >
          {isUser ? '❯' : '●'}
        </span>
        <span className="text-sm font-semibold text-foreground">
          {isUser ? '你' : '助手'}
        </span>
        <span className="text-xs text-foreground-muted">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-2.5 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {expanded ? '收起' : '展开'}
          </button>
          <button
            onClick={handleCopy}
            className="px-2.5 py-1 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors inline-flex items-center gap-1.5"
          >
            {copied && <Icon name="check" size={12} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      {/* 思维链（assistant 消息）—— 先于轨迹时间线，符合「思考 → 动作 → 答复」阅读序 */}
      {message.role === 'assistant' && message.reasoning ? (
        <ThinkingBlock
          text={message.reasoning}
          isStreaming={message.isStreaming}
          enabled={message.showReasoning !== false}
        />
      ) : null}

      {/* 工具执行（思考 → 动作 → 答复，与轨迹/调用的阅读序一致） */}
      {hasToolExecutions && (
        <Suspense fallback={null}>
          <ToolExecutionPanel messageId={message.id} />
        </Suspense>
      )}

      {/* 思考轨迹 */}
      {message.trajectory && message.trajectory.length > 0 && (
        <TrajectoryTimeline steps={message.trajectory} />
      )}

      {/* 工具调用 */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mb-3 space-y-1">
          {message.toolCalls.map(tool => (
            <ToolCallCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      {/* 消息内容 — 内嵌终端形态（.khy-tui 作用域只保留等宽字体，色彩继承
          外壳令牌）：用户与 AI 均为左对齐终端正文，角色差异由头部提示符与
          颜色承担；右对齐描边气泡已移除（用户拍板：整块终端化）。
          删掉通栏分隔线后，用户轮加一层轻底板，给「我说的 / 它答的」一个
          非色彩锚点（DOM 仅加类，不增删节点）。
          失败消息（status==='error'，或网关把错误包装成正文的 "API Error:..."）
          渲染为错误卡片而不是普通正文。 */}
      {expanded && (
        <div className="text-sm text-foreground pl-10">
          {message.role === 'assistant' && (message.failed || /^API Error:/i.test(message.content)) ? (
            <ErrorCard message={message} />
          ) : (
            <MarkdownRenderer
              content={message.content}
              isStreaming={message.isStreaming}
              // 用户轮加一层轻底板：删掉通栏分隔线后，「我说的 / 它答的」需要
              // 一个非色彩的锚点。类加在消息体根节点上，不新增 DOM 节点。
              className={isUser ? 'bg-surface rounded-lg px-3 py-2' : ''}
            />
          )}
        </div>
      )}
    </div>
  )
}

export function MessageList({ onQuickAction, composer, onRetryLoad, showReasoning = true }: {
  onQuickAction?: (prompt: string) => void
  // 空态首页把居中悬浮 composer 卡片嵌入问候语下方（ZC-ALIGN-005 E3）；
  // 非空态走底部固定 composer，此时传 undefined。
  composer?: ReactNode
  // 会话加载失败时的「重试」回调（App 层持有 currentSessionId 与加载逻辑）。
  onRetryLoad?: () => void
  // 「显示思考过程」设置（settings.showReasoning，缺省 true）。经 App 层挂载 /
  // 离开设置页时重读主进程 settings.json 后下传；缺省 true 与设置开关的
  // `showReasoning !== false` 同口径，读不到设置时一律显示。
  showReasoning?: boolean
}) {
  // Live messages from Redux — Composer dispatches addMessage / updateMessage,
  // App.tsx feeds host ai:chunk streams via appendMessageContent. The previous
  // static quicksort demo violated "state transparency" (fake chat content).
  const messages = useAppSelector((s: { message: { messages: StoreMessage[] } }) => s.message.messages)
  // 会话加载状态：唯一真源在 messageSlice（发起置位、成功/失败都复位）。
  // 加载中 → 骨架；加载失败 → 显式错误态；都优先于空态判断。
  const sessionLoading = useSessionLoadSignal()
  const sessionError = useSessionLoadError()
  const messagesSessionId = useMessagesSessionId()
  const view = resolveMessageAreaView({
    isLoading: sessionLoading,
    error: sessionError,
    messageCount: messages.length,
  })
  // 消息行（正常列表与「重载失败但内容仍属本会话」的失败态共用一份渲染）
  // ⚠ messageRows 用 `as Message` 强转，新字段漏传不会报 TS 错、只会静默不生效
  // —— 思维链显隐必须在这里显式传下去（见 Message.showReasoning）。
  const messageRows = messages.map((msg) => (
    <MessageBubble
      key={msg.id}
      message={{
        id: msg.id,
        role: msg.role === 'system' ? 'assistant' : msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        isStreaming: msg.status === 'streaming' || msg.status === 'sending',
        failed: msg.status === 'error',
        error: msg.error,
        reasoning: selectMessageReasoning({ message: { messages } }, msg.id),
        showReasoning,
      } as Message}
    />
  ))

  // 分支优先级：加载态必须先于空态判断 —— 加载历史会话时
  // setMessages([]) + 加载中会先撞 empty 分支，闪一下首页问候再切骨架。
  // 骨架与错误分支都必须保留 composer 插槽：否则「加载失败 + 屏幕上没有消息」时
  // 界面上一个输入框都没有（底部 composer 只在有消息时渲染），用户只能重试或换会话。
  if (view === 'loading') {
    return (
      <div className="flex-1 overflow-auto khy-tui">
        <div className="khy-content-col py-4 space-y-4">
          <SkeletonBubble />
          <SkeletonBubble />
          <SkeletonBubble />
          {composer && <div className="pt-2">{composer}</div>}
        </div>
      </div>
    )
  }

  // 失败态：加载失败时不能只剩空态（那等于「什么都没发生」）。这里给出
  // 失败原因 + 重试入口；重试由 App 层重新发起一次加载。
  // 屏幕上的内容是否保留：重载本会话失败 → 内容仍属于本会话（留下有用）；
  // 切换会话失败 → 内容是上一个会话的陈旧数据（必须隐藏）。
  if (view === 'error') {
    const described = describeSessionLoadError(sessionError?.reason ?? null)
    const keepContent = shouldKeepMessagesOnFailure(sessionError, messagesSessionId)
    return (
      <div className="flex-1 overflow-auto khy-tui">
        <div className="khy-content-col py-4 space-y-4">
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 overflow-hidden">
            <div className="px-4 py-3">
              <div className="flex items-start gap-2">
                <Icon name="warning" size={14} className="text-destructive mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-destructive">
                    {described?.title || '会话内容加载失败'}
                  </div>
                  <div className="text-sm text-foreground/70 mt-1 leading-relaxed break-words">
                    {described?.detail}
                  </div>
                  {described?.hint && (
                    <div className="text-xs text-foreground-muted mt-1 leading-relaxed">
                      {described.hint}
                    </div>
                  )}
                </div>
              </div>
              {onRetryLoad && (
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={onRetryLoad}
                    className="px-3 py-1.5 rounded-lg border border-destructive/40 text-xs text-destructive hover:bg-destructive/10 transition-colors inline-flex items-center gap-1.5"
                    title="重新加载该会话内容"
                  >
                    <Icon name="rotate-ccw" size={12} />
                    <span>重试</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          {keepContent && (
            <div className="space-y-1">
              {messageRows}
            </div>
          )}
          {/* 加载失败且屏幕上没有消息（切换会话失败）时，App 只会把卡片版 composer
              传进来 —— 这里必须渲染，否则输入区整个消失（见本分支顶部注释）。 */}
          {composer && <div className="pt-2">{composer}</div>}
        </div>
      </div>
    )
  }

  if (view === 'empty') {
    // 空态 = ZCode 新任务首页（问候 + 快捷卡片，ZC-ALIGN-002 E1），
    // 卡片动作经 onQuickAction 填入 composer（App 层持有 prefill 状态）。
    return <ChatEmptyState onQuickAction={onQuickAction} composer={composer} />
  }

  return (
    <div className="flex-1 overflow-auto khy-tui">
      {/* 行宽约束：滚动容器保持全宽（终端底色整条贯通），正文行收进居中内容列 */}
      <div className="khy-content-col space-y-1">
        {messageRows}
      </div>
    </div>
  )
}
