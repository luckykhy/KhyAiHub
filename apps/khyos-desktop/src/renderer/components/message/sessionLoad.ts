// khy-canary: Khy-20261102-302-GHYJTB3Y
// 会话加载信号 —— 消息区骨架屏的开关。
//
// 唯一真源：state/messageSlice 的 isLoadingSession（+ sessionLoadError）。
// 写入方只有一处：App.tsx 的 loadSessionMessages —— 发起时 dispatch
// (sessionLoadStarted())，成功 dispatch(sessionLoadSucceeded())，失败
// dispatch(sessionLoadFailed({ sessionId, reason }))。三条路径都复位，骨架屏
// 不会悬空。
//
// 本文件此前用的是「指针交互时间戳 + 5 秒兜底超时」的推断：会话 id 变了
// 且最近 2 秒内有过 pointerdown，就认为在加载，5 秒后无条件收摊。推断的
// 代价是失败路径根本走不到「内容落地」，于是骨架在消息区挂满 5 秒，然后
// 无声切回空态 —— 用户看到的是「转了 5 秒然后什么都没有」。真源落地后
// 这套启发式整体删除：加载态由发起方显式置位/复位，失败由显式错误态呈现。
//
// 启动自动选中的边界也因此自然成立：AppLayout 启动时拉到任务列表后只
// dispatch(setCurrentSession(id))，不伴随任何内容加载（没有
// sessionLoadStarted），所以不会误亮骨架 —— 不再需要「有没有用户交互」
// 这种间接判据。

import { useAppSelector } from '../../state/store'
import type { SessionLoadFailure } from '../../state/messageSlice'

/**
 * 加载中的兜底超时：preload 的 IPC 调用没有自带超时，host 进程挂死时
 * promise 永不 settle，骨架会永久停留。
 *
 * 这是**安全网**而不是正常路径的一环：成功（then）与失败（catch/!ok）
 * 两条路径都会走 finish() 清掉这个定时器，正常路径绝不依赖它；只有
 * 「什么都没回来」时它才兜底，且兜底动作是**显式失败**（置错误态 + 提示），
 * 不是无声收起骨架。
 */
export const SESSION_LOAD_TIMEOUT_MS = 15000

/** 消息区当前该渲染什么。优先级：加载 > 错误 > 空态 > 消息列表。 */
export type MessageAreaView = 'loading' | 'error' | 'empty' | 'list'

/**
 * 消息区的视图判定（纯函数，可在无 DOM 环境下测）。
 *
 * - loading：会话内容加载中 → 渲染骨架泡
 * - error：加载失败 → 渲染显式错误态（不能只剩空态）
 * - empty：没有消息且没有失败 → 首页空态
 * - list：有消息 → 正常消息列表
 */
export function resolveMessageAreaView(input: {
  isLoading: boolean
  error: SessionLoadFailure | null
  messageCount: number
}): MessageAreaView {
  if (input.isLoading) return 'loading'
  if (input.error) return 'error'
  if (input.messageCount === 0) return 'empty'
  return 'list'
}

/**
 * 失败时屏幕上的内容还能不能留（纯函数）。
 *
 * · 「重载本会话失败」——屏幕上的内容就是这个会话的（最后一份已知良好内容），
 *   留着比清空有用：用户还能读、能继续对话，只需知道这次刷新失败了；
 * · 「切换到别的会话失败」——屏幕上是**上一个**会话的陈旧内容，留着就是在
 *   别的会话名下显示旧内容，必须隐藏。
 */
export function shouldKeepMessagesOnFailure(
  failure: SessionLoadFailure | null,
  messagesSessionId: string | null,
): boolean {
  if (!failure || !messagesSessionId) return false
  return failure.sessionId === messagesSessionId
}

/**
 * 失败原因 → 用户可见的错误文案（纯函数）。
 * 超时与普通失败分开措辞：前者是 host 无响应，后者是读取/通道失败。
 */
export function describeSessionLoadError(raw: string | null): {
  title: string
  detail: string
  hint: string
} | null {
  if (!raw) return null
  const timedOut = /超时|timeout/i.test(raw)
  return {
    title: timedOut ? '会话内容加载超时' : '会话内容加载失败',
    detail: raw,
    hint: timedOut
      ? 'host 进程未在超时时间内返回，消息区已停止等待。可点「重试」重新加载。'
      : '本次加载没有成功，消息区显示的不是最新内容。可点「重试」重新加载；若持续失败请重启应用。',
  }
}

/**
 * 落库消息的 content → 思维链全文（纯函数，可在无 DOM 环境下测）。
 *
 * 只有块数组形态可能带思维链：抽出 `type === 'thinking'` 块的 `.thinking`
 * 字符串字段，按顺序拼接。其余形态（host 已拍平成字符串，见
 * host/index.ts）恒返回 '' —— 没有依据时返回空，不猜。
 */
export function loadedMessageReasoning(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; thinking?: string }
      return b && b.type === 'thinking' && typeof b.thinking === 'string' ? b.thinking : ''
    })
    .join('')
}

/**
 * 会话是否正在加载。true 时消息区应渲染骨架泡而不是旧内容 / 首页空态。
 */
export function useSessionLoadSignal(): boolean {
  return useAppSelector((s: { message: { isLoadingSession: boolean } }) => s.message.isLoadingSession)
}

/** 最近一次会话加载失败的信息（null = 当前没有失败）。 */
export function useSessionLoadError(): SessionLoadFailure | null {
  return useAppSelector((s: { message: { sessionLoadError: SessionLoadFailure | null } }) => s.message.sessionLoadError)
}

/** 当前消息数组属于哪个会话（null = 没有会话内容）。 */
export function useMessagesSessionId(): string | null {
  return useAppSelector((s: { message: { messagesSessionId: string | null } }) => s.message.messagesSessionId)
}
