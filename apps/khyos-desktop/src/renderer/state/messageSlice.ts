// khy-canary: Khy-20261102-344-YW3R43FS
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'sending' | 'streaming' | 'complete' | 'error'

export interface TrajectoryStep {
  type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  timestamp: number
}

export interface Message {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  status: MessageStatus
  trajectory?: TrajectoryStep[]
  toolCallIds?: string[]
  /**
   * Full reasoning text (assistant messages only). Accumulated chunk by chunk
   * during streaming via appendMessageReasoning; the finishing paths
   * (updateMessage / setMessageStatus) never write this field, so a reasoning
   * chain is never wholesale overwritten by res.text. Empty string / undefined
   * = this message has no reasoning chain, UI renders no block.
   * Never set on user messages.
   */
  reasoning?: string
  error?: string
}

/** 一次会话加载失败：针对哪个会话、什么原因（用户可见原文）。 */
export interface SessionLoadFailure {
  /** 加载失败针对的会话 id。 */
  sessionId: string
  /** 失败原因原文。 */
  reason: string
}

interface MessageState {
  messages: Message[]
  currentSessionId: string | null
  isStreaming: boolean
  // Wall-clock time of the in-flight request start (null at rest) — lets any
  // component show an elapsed counter without owning the send itself.
  streamingSince: number | null
  isAgentWorking: boolean
  currentThinking: string | null
  error: string | null
  // 会话内容加载：唯一真源。发起加载时置位，成功与失败两条路径都复位。
  // 之前消息区的骨架屏靠「指针交互时间戳 + 5 秒兜底」推断加载态（见
  // components/message/sessionLoad.ts 的历史注释），失败分支不写任何状态，
  // 结果是「失败后骨架挂满 5 秒再无声切回空态」。加载态必须由发起方
  // 显式置位/复位，不能由消费方猜。
  isLoadingSession: boolean
  // 最近一次会话加载失败的信息（null = 当前没有失败）。用于消息区的
  // 显式错误态：失败必须让用户看得见，不能只剩空态。
  sessionLoadError: SessionLoadFailure | null
  // 当前 messages 数组属于哪个会话（null = 没有会话内容，如新任务首页）。
  // 用来区分「重载本会话失败」（屏幕上的内容仍然有效，应保留）与
  // 「切换到别的会话失败」（屏幕上是上一个会话的陈旧内容，应隐藏）。
  messagesSessionId: string | null
  // Last prompt the user actually sent (retry source) and a monotonically
  // increasing seq the Composer watches to consume retry requests exactly once.
  lastPrompt: string
  retry: { prompt: string; seq: number } | null
}

const initialState: MessageState = {
  messages: [],
  currentSessionId: null,
  isStreaming: false,
  streamingSince: null,
  isAgentWorking: false,
  currentThinking: null,
  error: null,
  isLoadingSession: false,
  sessionLoadError: null,
  messagesSessionId: null,
  lastPrompt: '',
  retry: null,
}

const messageSlice = createSlice({
  name: 'message',
  initialState,
  reducers: {
    addMessage: (state, action: PayloadAction<Message>) => {
      state.messages.push(action.payload)
    },
    updateMessage: (state, action: PayloadAction<{ id: string; updates: Partial<Message> }>) => {
      const { id, updates } = action.payload
      const message = state.messages.find(m => m.id === id)
      if (message) Object.assign(message, updates)
    },
    appendMessageContent: (state, action: PayloadAction<{ id: string; content: string }>) => {
      const { id, content } = action.payload
      const message = state.messages.find(m => m.id === id)
      if (message) message.content += content
    },
    // Thinking chunks ride their own field so they never land in `content`
    // (the finishing path overwrites content with res.text). `?? ''` is
    // required: Composer creates the assistant message without a reasoning
    // field, and without it the first chunk would splice in "undefined...".
    // Unknown id → silent no-op (identical lookup to appendMessageContent).
    appendMessageReasoning: (state, action: PayloadAction<{ id: string; text: string }>) => {
      const { id, text } = action.payload
      const message = state.messages.find(m => m.id === id)
      if (message) message.reasoning = (message.reasoning ?? '') + text
    },
    setMessageStatus: (state, action: PayloadAction<{ id: string; status: MessageStatus }>) => {
      const { id, status } = action.payload
      const message = state.messages.find(m => m.id === id)
      if (message) message.status = status
    },
    setStreaming: (state, action: PayloadAction<boolean>) => {
      state.isStreaming = action.payload
      state.streamingSince = action.payload ? Date.now() : null
    },
    recordLastPrompt: (state, action: PayloadAction<string>) => {
      state.lastPrompt = action.payload
    },
    requestRetry: (state, action: PayloadAction<string>) => {
      state.retry = { prompt: action.payload, seq: (state.retry?.seq ?? 0) + 1 }
    },
    setAgentWorking: (state, action: PayloadAction<boolean>) => {
      state.isAgentWorking = action.payload
    },
    setCurrentThinking: (state, action: PayloadAction<string | null>) => {
      state.currentThinking = action.payload
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload
    },
    clearMessages: (state) => {
      state.messages = []
      state.isStreaming = false
      state.streamingSince = null
      state.isAgentWorking = false
      state.currentThinking = null
      state.error = null
      state.isLoadingSession = false
      state.sessionLoadError = null
      state.messagesSessionId = null
      state.lastPrompt = ''
      state.retry = null
    },
    // Replace the whole stream at once — used when a persisted session is
    // loaded (sidebar task click / 重载会话). Keeps streaming/agent flags at
    // rest so a load never looks like an in-flight generation.
    // 带会话 id：消息区要靠它判断「屏幕上的内容属于哪个会话」（失败态下决定
    // 该不该保留这批内容）。
    setMessages: (state, action: PayloadAction<{ sessionId: string; messages: Message[] }>) => {
      state.messages = action.payload.messages
      state.messagesSessionId = action.payload.sessionId
      state.isStreaming = false
      state.streamingSince = null
      state.isAgentWorking = false
      state.currentThinking = null
      state.error = null
    },
    setCurrentSession: (state, action: PayloadAction<string>) => {
      state.currentSessionId = action.payload
    },
    // 会话加载生命周期：发起 → 成功 / 失败。两条落地路径都必须复位
    // isLoadingSession，否则消息区会永久停在骨架屏（失败路径尤其致命：
    // 骨架消失后只剩空态，用户完全看不出「加载失败过」）。
    sessionLoadStarted: (state) => {
      state.isLoadingSession = true
      // 新一轮加载开始 → 上一轮的失败原因作废（否则旧错误会和新骨架并存）
      state.sessionLoadError = null
    },
    sessionLoadSucceeded: (state) => {
      state.isLoadingSession = false
      state.sessionLoadError = null
    },
    sessionLoadFailed: (state, action: PayloadAction<SessionLoadFailure>) => {
      state.isLoadingSession = false
      state.sessionLoadError = {
        sessionId: action.payload.sessionId,
        reason: action.payload.reason || '会话内容加载失败',
      }
    },
    // 用户已开始新动作（发送消息）→ 上一次加载失败的原因作废。
    // 否则错误态（优先级高于列表）会把新发出的用户泡与流式回复一起挡住，
    // 或在同会话重载失败时让陈旧横幅一直压在活跃对话上方。
    clearSessionLoadError: (state) => {
      state.sessionLoadError = null
    },
  },
})

export const {
  addMessage, updateMessage, appendMessageContent, appendMessageReasoning, setMessageStatus,
  setStreaming, setAgentWorking, setCurrentThinking, setError,
  clearMessages, setCurrentSession, setMessages,
  recordLastPrompt, requestRetry,
  sessionLoadStarted, sessionLoadSucceeded, sessionLoadFailed, clearSessionLoadError,
} = messageSlice.actions

/** Reasoning chain of one message ('' when it has none). Pure, no dependencies. */
export const selectMessageReasoning = (
  state: { message: { messages: Message[] } },
  id: string,
): string => state.message.messages.find((m) => m.id === id)?.reasoning ?? ''

export default messageSlice.reducer
