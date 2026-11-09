// 会话存档里的工具过程还原。
//
// 后端 JSONL 一直存着工具过程，且有两代形态：
//   1. 结构化：assistant 的 tool_use（名字 + 入参 + id），结果在工具轮 user 消息的
//      tool_result 块里（按 tool_use_id 回填）；
//   2. 纯文本：工具轮是一条字符串用户消息，形如
//      `[Tool execution results]\nTool: readFile [tool_use_id=…]\nResult: …`
//      （非结构化适配器 / 旧版循环留下的）。
// host 的 session.messages 此前只把 content 拍平成正文，两代过程都被丢掉 ——
// 重开旧会话只剩「一问一答」。这里只做配对，不碰渲染：结构化优先，纯文本兜底，
// 都没有才标 cancelled。
//
// 结果块可能落在这条 assistant 之后的任意 user 轮（并行调用时多个结果挤在同一
// 轮），所以先整表收集再逐条回填。

export interface PersistedToolCall {
  name: string
  input: Record<string, unknown>
  status: 'success' | 'error' | 'cancelled'
  result?: string
  error?: string
}

type Block = { type?: unknown; [key: string]: unknown }

// 与渲染层在线路径同一档（App.tsx 里 resultText.slice(0, 4000) / slice(0, 600)）：
// 历史灌回的单条结果不能比在线时更大，否则一次加载旧会话就能把 IPC 与 Redux 撑爆。
const RESULT_MAX = 4000
const ERROR_MAX = 600

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function blocksOf(content: unknown): Block[] {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is Block => !!b && typeof b === 'object')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : String(p ?? '')))
      .join('')
  }
  if (content && typeof content === 'object') return String((content as { text?: unknown }).text ?? '')
  return ''
}

type PlainResult = { text: string; status: 'success' | 'error' | 'cancelled' }

const TEXT_MARKER = /\[tool_use_id=([A-Za-z0-9_-]+)\]/g

// 纯文本结果按标记切段：段 = 本标记之后到下一个标记之前。
// 「已取消」是用户 ESC 的真实语义，不能并进「失败」；SKIPPED / BLOCKED 是循环
// 闸门的拒绝，按失败算（调用确实没有产出）。
function collectTextResults(messages: { role?: string; content?: unknown }[]): Map<string, PlainResult> {
  const results = new Map<string, PlainResult>()
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue
    const text = m.content
    const hits: { id: string; from: number; at: number }[] = []
    TEXT_MARKER.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TEXT_MARKER.exec(text))) {
      hits.push({ id: match[1], from: match.index + match[0].length, at: match.index })
    }
    hits.forEach((hit, i) => {
      if (results.has(hit.id)) return
      // 下一个标记前面还挂着它的 `Tool: <名字> ` 前缀，一并切掉，别混进上一条结果。
      const segment = text
        .slice(hit.from, i + 1 < hits.length ? hits[i + 1].at : text.length)
        .replace(/\nTool: [^\n]*$/, '')
        .trim()
      const body = segment.startsWith('Result: ') ? segment.slice('Result: '.length) : segment
      const cancelled = body.includes('[ERROR:CANCELLED]')
      const failed = cancelled || /\[ERROR:[A-Z_]+\]/.test(body) || /\((?:SKIPPED|BLOCKED)\b/.test(body)
      results.set(hit.id, { text: body, status: cancelled ? 'cancelled' : failed ? 'error' : 'success' })
    })
  }
  return results
}

/**
 * 按消息下标返回该条消息发起的工具调用。结构化结果优先，纯文本结果兜底；
 * 两代都配不到的标 cancelled（中断 / 进程退出时存档里只有 tool_use，
 * 不能假装成功）。
 */
export function collectToolCalls(
  messages: { role?: string; content?: unknown }[]
): Map<number, PersistedToolCall[]> {
  const structured = new Map<string, { content: unknown; isError: boolean }>()
  for (const m of messages) {
    for (const b of blocksOf(m.content)) {
      if (b.type !== 'tool_result') continue
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
      if (!id) continue
      structured.set(id, { content: b.content, isError: b.is_error === true })
    }
  }
  const plain = collectTextResults(messages)

  const found = new Map<number, PersistedToolCall[]>()
  messages.forEach((m, index) => {
    if (m.role !== 'assistant') return
    const calls: PersistedToolCall[] = []
    for (const b of blocksOf(m.content)) {
      if (b.type !== 'tool_use') continue
      const id = typeof b.id === 'string' ? b.id : ''
      const hit = id ? structured.get(id) : undefined
      const fallback = !hit && id ? plain.get(id) : undefined
      const call: PersistedToolCall = {
        name: typeof b.name === 'string' && b.name.trim() ? b.name : '工具',
        input: b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {},
        status: 'cancelled',
      }
      if (hit) {
        const text = textOf(hit.content)
        if (hit.isError) {
          call.status = 'error'
          call.error = clip(text, ERROR_MAX)
        } else {
          call.status = 'success'
          call.result = clip(text, RESULT_MAX)
        }
      } else if (fallback) {
        call.status = fallback.status
        if (fallback.status === 'success') call.result = clip(fallback.text, RESULT_MAX)
        if (fallback.status === 'error') call.error = clip(fallback.text, ERROR_MAX)
      }
      calls.push(call)
    }
    if (calls.length > 0) found.set(index, calls)
  })
  return found
}
