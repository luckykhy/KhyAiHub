// khy-canary: Khy-20261102-291-AZEEYHH3
// sessionListLoad.ts —— 侧栏会话列表的加载状态机（纯逻辑，可在无 DOM 环境下测）。
//
// 为什么要有这个文件：侧栏此前是「挂载时拉一次，拉不到就摆错误态」的写法 ——
// 一次失败就把整个侧栏变成死画面，既不重试也没有重试入口，用户只能重启应用
// （用户实测：会话列表总是加载失败）。消息区早就有同款状态机
// （components/message/sessionLoad.ts），侧栏这次补上同一套形状。
//
// 真源边界：
//   · 状态真源在 AppLayout 的 React state（tasks / sessionError / sessionLoading）；
//   · 本文件只放**判定与文案**（纯函数），保证这部分可被 node:test 直接钉住。
//
// 判定优先级（与 resolveMessageAreaView 同构）：
//   已有列表 > 加载中 > 错误 > 空态
// 「已有列表」排第一：刷新失败时**保留上一次的好列表**（用户还能看到会话），
// 只在错误态里提示「这次没刷上」，而不是把已知内容清空。

/** 重试节奏：第 n 次尝试失败后，等待多久再试（毫秒）。null = 不再重试。 */
export const SESSION_LIST_RETRY_DELAYS_MS: readonly number[] = [1200, 4000, 9000]

/**
 * 渲染层安全网：preload 的 IPC 调用本身没有超时，host 挂死时 promise 永不
 * settle。与消息区同一思路 —— 这是兜底，不是正常路径的一环；成功与失败
 * 两条路径都会清掉它。
 */
export const SESSION_LIST_TIMEOUT_MS = 25_000

/** 侧栏任务区当前该渲染什么。 */
export type SessionListView = 'loading' | 'error' | 'empty' | 'list'

export interface SessionListViewInput {
  /** 正在拉取会话列表 */
  loading: boolean
  /** 最近一次失败原因（null / '' = 没有失败） */
  error: string | null
  /** 当前已持有的会话条数 */
  taskCount: number
  /** 搜索框有内容（决定空态文案是「还没有任务」还是「没有匹配的任务」） */
  searching: boolean
}

/**
 * 视图判定（纯函数）。
 *
 * - 已经有列表 → 继续显示列表（刷新失败也不清空已知内容）
 * - 正在加载 → 骨架/加载态
 * - 有失败 → 显式错误态（必须给重试入口，不能只剩空态）
 * - 什么都没有 → 空态
 */
export function resolveSessionListView(input: SessionListViewInput): SessionListView {
  if (input.taskCount > 0) return 'list'
  if (input.loading) return 'loading'
  if (input.error) return 'error'
  if (input.searching) return 'empty'
  return 'empty'
}

/** 空态副标题：区分「没有会话」与「搜索没匹配上」。 */
export function describeSessionListEmpty(searching: boolean): string {
  return searching ? '尝试其它搜索词' : '点击上方「新建任务」或 Ctrl+N 创建新任务'
}

/**
 * 下一次重试该等多久（毫秒）。超出重试次数返回 null（不再自动重试，
 * 改由用户点「重试」）。
 */
export function nextRetryDelay(attempt: number): number | null {
  if (!Number.isFinite(attempt) || attempt < 0) return null
  const delays = SESSION_LIST_RETRY_DELAYS_MS
  if (attempt >= delays.length) return null
  return delays[attempt]
}

/**
 * 失败原因 → 用户可见的错误文案（纯函数）。
 *
 * 超时与普通失败分开措辞：前者是 host 无响应，后者是读取/通道失败 ——
 * 两者要的补救动作不一样（重试 vs 重启），不能混成一句话。
 */
export function describeSessionListError(raw: string | null): {
  title: string
  detail: string
  hint: string
} | null {
  if (!raw) return null
  const timedOut = /超时|无响应|timeout/i.test(raw)
  return {
    title: timedOut ? '会话列表加载超时' : '会话列表加载失败',
    detail: raw,
    hint: timedOut
      ? 'host 进程长时间没有返回会话列表（超时）。系统已自动重试过，可点「重试」再试一次；若持续失败请重启应用。'
      : '本次没有读到会话列表。系统已自动重试过，可点「重试」再试一次；若持续失败请重启应用。',
  }
}

/**
 * 标题兜底：会话标题为空或占位符时，用首条用户消息的前 40 字顶上
 * （与 AppLayout 的映射口径一致，抽出来是为了两处不会漂）。
 */
export function resolveSessionTitle(session: {
  title?: string
  firstUserMessage?: string
}): string {
  const title = String(session.title || '').trim()
  const first = String(session.firstUserMessage || '').trim()
  if (title && title !== '(untitled)') return title
  if (first) return `${first.slice(0, 40)}${first.length > 40 ? '…' : ''}`
  return title || '未命名会话'
}
