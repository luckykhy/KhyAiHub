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
  error?: string
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
      state.lastPrompt = ''
      state.retry = null
    },
    // Replace the whole stream at once — used when a persisted session is
    // loaded (sidebar task click / 重载会话). Keeps streaming/agent flags at
    // rest so a load never looks like an in-flight generation.
    setMessages: (state, action: PayloadAction<Message[]>) => {
      state.messages = action.payload
      state.isStreaming = false
      state.streamingSince = null
      state.isAgentWorking = false
      state.currentThinking = null
      state.error = null
    },
    setCurrentSession: (state, action: PayloadAction<string>) => {
      state.currentSessionId = action.payload
    },
  },
})

export const {
  addMessage, updateMessage, appendMessageContent, setMessageStatus,
  setStreaming, setAgentWorking, setCurrentThinking, setError,
  clearMessages, setCurrentSession, setMessages,
  recordLastPrompt, requestRetry,
} = messageSlice.actions

export default messageSlice.reducer
