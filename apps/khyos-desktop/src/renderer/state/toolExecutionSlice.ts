import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ToolExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'

export interface ToolExecution {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolExecutionStatus
  result?: string
  error?: string
  startedAt: number
  completedAt?: number
  affectedFiles?: string[]
  requiresConfirmation: boolean
  /**
   * 这次执行属于哪条助手消息（= 哪一轮提问）。
   * 渲染层按它把过程挂回**对应的那一条**消息；空串 = 没有归属的迟到事件，
   * 任何消息都不认领（宁可不显示，也不能挂到别的会话/别的提问上）。
   */
  messageId: string
}

interface ToolExecutionState {
  executions: ToolExecution[]
  activeIds: string[]
  history: ToolExecution[]
  /** 本轮被编辑类工具改过的文件（去重）；P2 的 DiffSummary 数据源 */
  affectedFiles: string[]
  /** 当前这一轮的助手消息 id（Composer 发送时登记），新执行一律归属到它 */
  turnMessageId: string | null
}

const initialState: ToolExecutionState = {
  executions: [],
  activeIds: [],
  history: [],
  affectedFiles: [],
  turnMessageId: null,
}

// 一次会话内保留的执行记录上限。每轮累积、只在切会话时清零；结果文本单条
// 最长 4000 字符，300 条 ≈ 1.2 MB 量级，长会话也不会失控。
const MAX_EXECUTIONS = 300

const toolExecutionSlice = createSlice({
  name: 'toolExecution',
  initialState,
  reducers: {
    // 开一轮新的提问：登记本轮的助手消息 id，并把「本轮文件改动」清空。
    // 执行记录**不清** —— 每一轮的过程要留在它自己那条提问下面；只有切换
    // 会话（clearExecutions）才整批丢弃。此前发送即清空，是全局单块面板的
    // 遗留：不清就会被下一条覆盖性地「借用」。
    // 上一轮没收尾的执行（异常中断、没等到 ai.result）在这里标成已取消，
    // 否则 activeIds 会残留，界面上一直转圈。
    beginToolTurn: (state, action: PayloadAction<{ messageId: string }>) => {
      for (const id of state.activeIds) {
        const execution = state.executions.find(e => e.id === id)
        if (execution) {
          execution.status = 'cancelled'
          execution.completedAt = Date.now()
        }
      }
      state.activeIds = []
      state.affectedFiles = []
      state.turnMessageId = action.payload.messageId || null
      // 长会话的保护：每轮都累积，超上限丢最早的（连同其 activeIds）。
      if (state.executions.length > MAX_EXECUTIONS) {
        state.executions = state.executions.slice(-MAX_EXECUTIONS)
        const kept = new Set(state.executions.map(e => e.id))
        state.activeIds = state.activeIds.filter(id => kept.has(id))
      }
    },
    startToolExecution: (state, action: PayloadAction<Omit<ToolExecution, 'status' | 'startedAt' | 'messageId'>>) => {
      const execution: ToolExecution = {
        ...action.payload,
        messageId: state.turnMessageId ?? '',
        status: 'running',
        startedAt: Date.now(),
      }
      state.executions.push(execution)
      state.activeIds.push(execution.id)
    },
    updateToolExecution: (state, action: PayloadAction<{ id: string; status: ToolExecutionStatus; result?: string; error?: string }>) => {
      const { id, status, result, error } = action.payload
      const execution = state.executions.find(e => e.id === id)
      if (execution) {
        execution.status = status
        if (result !== undefined) execution.result = result
        if (error !== undefined) execution.error = error
        if (status === 'success' || status === 'error' || status === 'cancelled') {
          execution.completedAt = Date.now()
          state.activeIds = state.activeIds.filter(aid => aid !== id)
          state.history.unshift(execution)
          if (state.history.length > 50) state.history.pop()
        }
      }
    },
    cancelToolExecution: (state, action: PayloadAction<string>) => {
      const execution = state.executions.find(e => e.id === action.payload)
      if (execution) {
        execution.status = 'cancelled'
        execution.completedAt = Date.now()
        state.activeIds = state.activeIds.filter(aid => aid !== action.payload)
      }
    },
    recordAffectedFiles: (state, action: PayloadAction<string[]>) => {
      for (const f of action.payload) {
        if (f && !state.affectedFiles.includes(f)) state.affectedFiles.push(f)
      }
    },
    clearExecutions: (state) => {
      state.executions = []
      state.activeIds = []
      state.affectedFiles = []
      state.turnMessageId = null
    },
    clearHistory: (state) => {
      state.history = []
    },
  },
})

export const {
  beginToolTurn, startToolExecution, updateToolExecution, cancelToolExecution,
  recordAffectedFiles, clearExecutions, clearHistory,
} = toolExecutionSlice.actions

export default toolExecutionSlice.reducer
